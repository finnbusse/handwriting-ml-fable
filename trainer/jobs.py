"""One training job at a time, for the trainer Space (no web framework in here).

The job is `scripts/retrain.py run --runner space ...` as a subprocess.  The
caller's Hugging Face token is held in memory and handed to that subprocess in
its environment (HF_TOKEN); it is never written to disk and never logged: every
log line is scrubbed before it is kept.
"""
from __future__ import annotations

import collections
import hashlib
import importlib.util
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_LINES = 200
WHOAMI_TTL = 600          # seconds an owner check is remembered (per token, in memory)
_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{6,}")


class Refused(Exception):
    """kind: 'auth' (no or invalid token) | 'owner' (someone else) | 'busy' | 'options' | 'idle'"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def retrain_defaults() -> dict:
    """The defaults of scripts/retrain.py run, so the app can show them."""
    spec = importlib.util.spec_from_file_location("retrain_defaults", os.path.join(ROOT, "scripts", "retrain.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {"epochs": mod.EPOCHS, "lines_only": mod.LINES_ONLY, "sample_every": mod.SAMPLE_EVERY,
            "max_minutes": mod.MAX_MINUTES, "writer": mod.MAIN_WRITER}


def hub_whoami(token: str) -> str:
    """The account name a token belongs to (raises on an invalid token)."""
    from huggingface_hub import whoami

    return whoami(token=token)["name"]


def parse_options(o) -> dict:
    """Checks what the app sends; only known keys with sane values."""
    if o is None:
        o = {}
    if not isinstance(o, dict):
        raise Refused("options", "options must be an object")
    out = {}
    if o.get("epochs") is not None:
        e = o["epochs"]
        if not isinstance(e, int) or isinstance(e, bool) or not 1 <= e <= 200:
            raise Refused("options", "epochs: 1..200")
        out["epochs"] = e
    if o.get("lines_only") is not None:
        if not isinstance(o["lines_only"], bool):
            raise Refused("options", "lines_only: true/false")
        out["lines_only"] = o["lines_only"]
    if o.get("sample_every") is not None:
        s = o["sample_every"]
        if not isinstance(s, int) or isinstance(s, bool) or not 0 <= s <= 50:
            raise Refused("options", "sample_every: 0..50")
        out["sample_every"] = s
    if o.get("resume") is not None:
        if not isinstance(o["resume"], bool):
            raise Refused("options", "resume: true/false")
        out["resume"] = o["resume"]
    return out


def build_command(options: dict, run_id: str, workdir: str) -> list[str]:
    cmd = [sys.executable, "-u", os.path.join(ROOT, "scripts", "retrain.py"), "run", "--runner", "space",
           "--run-id", run_id, "--out", os.path.join(workdir, "run"),
           "--cache", os.path.join(workdir, "data_cache"), "--base", os.path.join(ROOT, "artifacts", "base"),
           # os.cpu_count() sees the host's cores, not the Space's 2 vCPU: too many threads would crawl
           "--threads", os.environ.get("HW_THREADS", "2")]
    if "epochs" in options:
        cmd += ["--epochs", str(options["epochs"])]
    if "lines_only" in options:
        cmd.append("--lines-only" if options["lines_only"] else "--all-data")
    if "sample_every" in options:
        cmd += ["--sample-every", str(options["sample_every"])]
    if options.get("resume"):
        cmd.append("--resume-run")
    return cmd


class Job:
    def __init__(self, run_id: str, options: dict):
        self.run_id, self.options = run_id, options
        self.started = time.time()
        self.finished: float | None = None
        self.exit_code: int | None = None
        self.stop_requested = False
        self.log: collections.deque[str] = collections.deque(maxlen=LOG_LINES)
        self.proc: subprocess.Popen | None = None
        self.stop_file = ""

    def message(self) -> str | None:
        """The driver's plain German reason, if it printed one ("Fehler: ...")."""
        for line in reversed(self.log):
            if line.startswith("Fehler: "):
                return line[len("Fehler: "):]
        return None


class Runner:
    def __init__(self, owner: str | None, whoami=hub_whoami, command=build_command, workdir: str | None = None,
                 env: dict | None = None):
        self.owner = (owner or "").strip()
        self.whoami = whoami
        self.command = command
        self.workdir = workdir or os.path.join(tempfile.gettempdir(), "handschrift-training")
        self.base_env = dict(os.environ if env is None else env)
        for k in ("HF_TOKEN", "HUGGINGFACE_ACCESS_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
            self.base_env.pop(k, None)           # only the caller's token, never a stored one
        self.job: Job | None = None
        self.lock = threading.Lock()
        self._known: dict[str, tuple[str, float]] = {}   # sha256(token) -> (name, until)

    # ---------------------------------------------------------------- owner
    def check(self, token: str | None) -> str:
        if not token:
            raise Refused("auth", "missing token")
        if not self.owner:
            raise Refused("owner", "SPACE_AUTHOR_NAME is not set; this runner accepts nobody")
        key = hashlib.sha256(token.encode()).hexdigest()
        hit = self._known.get(key)
        if hit and hit[1] > time.time():
            name = hit[0]
        else:
            try:
                name = self.whoami(token)
            except Exception:
                raise Refused("auth", "token not valid") from None
            self._known[key] = (name, time.time() + WHOAMI_TTL)
        if name.lower() != self.owner.lower():
            raise Refused("owner", "this runner belongs to another account")
        return name

    # ------------------------------------------------------------------ job
    def running(self) -> bool:
        return bool(self.job and self.job.exit_code is None)

    def start(self, token: str, options) -> Job:
        self.check(token)
        opts = parse_options(options)
        with self.lock:
            if self.running():
                raise Refused("busy", "a training is already running")
            run_id = time.strftime("%Y%m%d-%H%M%S-", time.gmtime()) + secrets.token_hex(2)
            os.makedirs(self.workdir, exist_ok=True)
            job = Job(run_id, opts)
            job.stop_file = os.path.join(self.workdir, f"stop-{run_id}")
            env = dict(self.base_env, HF_TOKEN=token, HW_STOP_FILE=job.stop_file, PYTHONUNBUFFERED="1",
                       PYTHONPATH=ROOT)
            job.proc = subprocess.Popen(self.command(opts, run_id, self.workdir), env=env, cwd=ROOT,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                        text=True, bufsize=1, start_new_session=True)
            self.job = job
        threading.Thread(target=self._pump, args=(job, token), daemon=True).start()
        return job

    def _pump(self, job: Job, token: str):
        for line in job.proc.stdout:
            job.log.append(scrub(line.rstrip("\n"), token))
        job.proc.stdout.close()
        job.exit_code = job.proc.wait()
        job.finished = time.time()
        try:
            os.remove(job.stop_file)
        except OSError:
            pass

    def stop(self, token: str, force: bool = False) -> Job:
        self.check(token)
        job = self.job
        if not self.running():
            raise Refused("idle", "no training is running")
        job.stop_requested = True
        with open(job.stop_file, "w") as f:      # the driver looks for it after every epoch
            f.write("stop")
        if force and job.proc:
            os.killpg(job.proc.pid, signal.SIGTERM)   # the driver reports "stopped" on SIGTERM
        return job

    def status(self, authorized: bool) -> dict:
        job = self.job
        out = {"service": "handschrift-training", "owner": self.owner or None, "running": self.running(),
               "job": None}
        if job:
            out["job"] = {"run_id": job.run_id, "started": iso(job.started), "finished": iso(job.finished),
                          "exit_code": job.exit_code, "stop_requested": job.stop_requested}
            if authorized:
                out["job"].update(options=job.options, log=list(job.log)[-40:], message=job.message())
        return out


def iso(t: float | None) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None


def scrub(text: str, token: str | None = None) -> str:
    if token:
        text = text.replace(token, "***")
    return _TOKEN_RE.sub("hf_***", text)

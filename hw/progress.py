"""Training progress in the model repo, for the web app's Training tab.

Whoever runs a training (the trainer Space, GitHub, Colab, a computer) writes
the same files into `<user>/handwriting-fable-model`:

    training/status.json        where the run is, in one small JSON (format below)
    training/sample.png         a few held-out lines: the writer's and the model's
    training/checkpoint/...     the run so far, so that an interrupted run can continue
    training/stop               written by the app to ask a running job to stop

Every upload goes through `Hub.commit` (one commit per call), so a test can
replace the hub.  `Progress.publish` never raises: a failed status upload is
logged and training goes on.

status.json, format 1:

    {"format": 1, "run_id": "20261125-141502-a1b2", "state": "running",
     "runner": "space", "runner_url": null,
     "started": "2026-11-25T14:15:02Z", "updated": "2026-11-25T14:43:10Z",
     "epoch": 7, "epochs": 30, "best_epoch": 6,
     "scores": [1.92, 1.41, 1.33, ...],        # index = epoch (0 = before training); null = not measured
     "minutes": 21.4, "minutes_left": 70.2, "epoch_minutes": 2.9,
     "lines": 143,                             # capture-app lines of the writer in the dataset
     "data": {"train_lines": 160, "val_lines": 13, ...},
     "writer": "finn", "lines_only": true, "resumed_from": null,
     "sample_epoch": 7, "sample_kind": "progress", "checkpoint_epoch": 5,
     "message": null, "error": null, "model_sha256": null}

state: starting | running | publishing | done | failed | stopped
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import math
import os
import re
import secrets
import shutil
import sys

STATUS = "training/status.json"
SAMPLE = "training/sample.png"
STOP = "training/stop"
CHECKPOINT = "training/checkpoint"
STATES = ("starting", "running", "publishing", "done", "failed", "stopped")
RUNNERS = ("space", "github", "colab", "local")


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_run_id() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)


def detect_runner() -> str:
    if os.environ.get("SPACE_ID"):
        return "space"
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return "github"
    if os.environ.get("COLAB_RELEASE_TAG") or "google.colab" in sys.modules:
        return "colab"
    return "local"


def runner_url() -> str | None:
    """A link to the run when the platform has one (GitHub Actions)."""
    if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_RUN_ID"):
        return (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
                f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ['GITHUB_RUN_ID']}")
    return None


_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{6,}")


def scrub(text: str, token: str | None = None) -> str:
    """Remove anything that looks like a Hugging Face token."""
    text = str(text)
    if token:
        text = text.replace(token, "***")
    return _TOKEN_RE.sub("hf_***", text)


def _status_code(exc) -> int | None:
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    return code if isinstance(code, int) else None


def german_message(exc: BaseException) -> str:
    """The reason for a failed run, in plain words for the app."""
    import subprocess

    code = _status_code(exc)
    name = type(exc).__name__
    if code in (401, 403):
        return "Dein Hugging-Face-Zugang darf das Modell nicht speichern. Bitte melde dich neu an."
    if code == 404:
        return "Deine Zeilen oder dein Modell wurden auf Hugging Face nicht gefunden."
    if code is not None and code >= 500:
        return "Hugging Face hatte gerade eine Störung."
    if isinstance(exc, MemoryError):
        return "Dem Rechner ist der Speicher ausgegangen."
    if isinstance(exc, NoCheckpoint):
        return "Es gibt keinen Zwischenstand, an dem das Training weitergehen könnte."
    if isinstance(exc, (ConnectionError, TimeoutError)) or name in (
            "ConnectionError", "ConnectTimeout", "ReadTimeout", "Timeout", "ChunkedEncodingError"):
        return "Die Verbindung zu Hugging Face ist abgebrochen."
    if isinstance(exc, subprocess.CalledProcessError):
        return "Das fertige Modell konnte nicht geprüft oder gespeichert werden."
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return "Auf dem Rechner ist kein Platz mehr frei."
    return "Beim Training ist ein Fehler aufgetreten."


class NoCheckpoint(RuntimeError):
    """--resume-run, but the model repo holds no complete training/checkpoint/."""


class Interrupted(BaseException):
    """The process was asked to end (SIGTERM, e.g. the Space shuts down)."""


# ----------------------------------------------------------------------- hubs
class Hub:
    """Where the progress goes: the model repo.  Subclasses implement these."""
    model_repo = ""

    def ensure_repo(self):
        pass

    def commit(self, files: dict, delete=(), message: str = "") -> None:
        """One commit: files maps repo path -> bytes or a local file path."""
        raise NotImplementedError

    def exists(self, path: str) -> bool:
        raise NotImplementedError

    def download(self, path: str, dest: str) -> str:
        """Download one file of the model repo to the local path `dest`."""
        raise NotImplementedError

    def list(self, prefix: str) -> list[str]:
        raise NotImplementedError

    def dataset_state(self, writer: str) -> dict:
        raise NotImplementedError


class HfHub(Hub):
    """The real thing: <user>/handwriting-fable(-model) on Hugging Face."""

    def __init__(self, token: str, dataset: str = "handwriting-fable", model: str = "handwriting-fable-model"):
        from huggingface_hub import HfApi

        self.token = token
        self.api = HfApi(token=token)
        self.user = self.api.whoami()["name"]
        self.dataset_repo = f"{self.user}/{dataset}"
        self.model_repo = f"{self.user}/{model}"

    def ensure_repo(self):
        self.api.create_repo(self.model_repo, repo_type="model", private=True, exist_ok=True)

    def commit(self, files: dict, delete=(), message: str = ""):
        from huggingface_hub import CommitOperationAdd, CommitOperationDelete

        ops = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=(io.BytesIO(v) if isinstance(v, bytes) else v))
               for p, v in files.items()]
        ops += [CommitOperationDelete(path_in_repo=p) for p in delete]
        if ops:
            self.api.create_commit(self.model_repo, ops, commit_message=message or "Training", repo_type="model")

    def exists(self, path: str) -> bool:
        return self.api.file_exists(self.model_repo, path, repo_type="model")

    def download(self, path: str, dest: str) -> str:
        from huggingface_hub import hf_hub_download

        got = hf_hub_download(self.model_repo, path, token=self.token, force_download=True)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.copyfile(got, dest)
        return dest

    def list(self, prefix: str) -> list[str]:
        return [p for p in self.api.list_repo_files(self.model_repo, repo_type="model") if p.startswith(prefix)]

    def dataset_state(self, writer: str) -> dict:
        info = self.api.dataset_info(self.dataset_repo)
        files = sorted(s.rfilename for s in info.siblings
                       if s.rfilename.startswith(f"raw/v1/{writer}/") and s.rfilename.endswith(".json"))
        return {"dataset": self.dataset_repo, "dataset_sha": info.sha, "files": files,
                "trained": self._trained_on()}

    def _trained_on(self) -> dict:
        try:
            with open(self.download("trained_on.json", os.path.join(_tmpdir(), "trained_on.json")),
                      encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}


def _tmpdir() -> str:
    import tempfile

    return tempfile.mkdtemp(prefix="hw-")


class LocalHub(Hub):
    """A folder that stands in for the model repo (tests, trying things out).
    `dataset_dir` is a local copy of the dataset (e.g. data_cache/<user>__handwriting-fable)."""

    def __init__(self, root: str, dataset_dir: str | None = None):
        self.root = root
        self.dataset_dir = dataset_dir
        self.model_repo = f"local:{root}"
        self.commits: list[dict] = []
        os.makedirs(root, exist_ok=True)

    def commit(self, files: dict, delete=(), message: str = ""):
        for p in delete:
            if not os.path.exists(os.path.join(self.root, p)):
                raise FileNotFoundError(p)
        for p, v in files.items():
            dest = os.path.join(self.root, p)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if isinstance(v, bytes):
                with open(dest + ".part", "wb") as f:
                    f.write(v)
                os.replace(dest + ".part", dest)
            else:
                shutil.copyfile(v, dest)
        for p in delete:
            os.remove(os.path.join(self.root, p))
        self.commits.append({"message": message, "files": sorted(files), "delete": list(delete)})

    def exists(self, path: str) -> bool:
        return os.path.isfile(os.path.join(self.root, path))

    def download(self, path: str, dest: str) -> str:
        src = os.path.join(self.root, path)
        if not os.path.isfile(src):
            raise FileNotFoundError(path)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.copyfile(src, dest)
        return dest

    def list(self, prefix: str) -> list[str]:
        out = []
        for d, _, names in os.walk(self.root):
            for n in names:
                p = os.path.relpath(os.path.join(d, n), self.root).replace(os.sep, "/")
                if p.startswith(prefix):
                    out.append(p)
        return sorted(out)

    def dataset_state(self, writer: str) -> dict:
        files = []
        base = os.path.join(self.dataset_dir or "", "raw", "v1", writer)
        if self.dataset_dir and os.path.isdir(base):
            for d, _, names in os.walk(base):
                files += [os.path.relpath(os.path.join(d, n), self.dataset_dir).replace(os.sep, "/")
                          for n in names if n.endswith(".json")]
        trained = {}
        if self.exists("trained_on.json"):
            with open(os.path.join(self.root, "trained_on.json"), encoding="utf-8") as f:
                trained = json.load(f)
        return {"dataset": self.dataset_dir or "", "dataset_sha": None, "files": sorted(files), "trained": trained}


def lines_digest(files: list[str]) -> str:
    return hashlib.sha256("\n".join(files).encode()).hexdigest()


# ------------------------------------------------------------------- progress
def _num(v):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(float(v), 4)


def estimate_minutes_left(history: list[dict], epoch: int, epochs: int, minutes: float,
                          max_minutes: float = 0, finish_minutes: float = 2.0) -> float:
    """Remaining epochs at the recent pace, plus the final check and upload.
    An upper estimate: training may end earlier when the held-out lines stop improving."""
    secs = [h["seconds"] for h in history if h.get("seconds")][-5:]
    per = (sum(secs) / len(secs) / 60) if secs else (minutes / epoch if epoch else 0)
    left = max(0, epochs - epoch) * per
    if max_minutes:
        left = min(left, max(0.0, max_minutes - minutes))
    return round(left + finish_minutes, 1)


class Progress:
    """The status of one run, published to the hub.  publish() never raises."""

    def __init__(self, hub: Hub, *, runner: str, epochs: int, run_id: str | None = None, log=print, **fields):
        self.hub = hub
        self.log = log
        self.failures = 0
        self.status = {"format": 1, "run_id": run_id or new_run_id(), "state": "starting",
                       "runner": runner if runner in RUNNERS else "local", "runner_url": runner_url(),
                       "started": now_iso(), "updated": now_iso(), "epoch": 0, "epochs": epochs,
                       "best_epoch": None, "scores": [], "minutes": 0.0, "minutes_left": None,
                       "epoch_minutes": None, "lines": None, "data": None, "writer": None, "lines_only": None,
                       "resumed_from": None, "sample_epoch": None, "sample_kind": None,
                       "checkpoint_epoch": None, "message": None, "error": None, "model_sha256": None}
        self.status.update(fields)

    def update(self, **fields):
        self.status.update(fields)

    def from_history(self, history: list[dict], epoch: int, best_epoch, minutes: float, max_minutes: float = 0):
        epochs = self.status["epochs"]
        scores: list = [None] * (max([h["epoch"] for h in history] + [0]) + 1)
        for h in history:
            scores[h["epoch"]] = _num(h.get("score"))
        secs = [h["seconds"] for h in history if h.get("seconds")][-5:]
        self.update(epoch=epoch, best_epoch=best_epoch, scores=scores, minutes=round(minutes, 1),
                    epoch_minutes=round(sum(secs) / len(secs) / 60, 2) if secs else None,
                    minutes_left=estimate_minutes_left(history, epoch, epochs, minutes, max_minutes))

    def body(self) -> bytes:
        return json.dumps(self.status, ensure_ascii=False, indent=1).encode("utf-8")

    def publish(self, state: str | None = None, files: dict | None = None, delete=(), strict: bool = False,
                message: str | None = None) -> bool:
        """One commit with status.json (+ files).  Returns True on success.  With
        strict=True a failure raises instead (used for the very first status, so a
        token that cannot write is noticed at once)."""
        if state:
            assert state in STATES, state
            self.status["state"] = state
        self.status["updated"] = now_iso()
        all_files = dict(files or {})
        all_files[STATUS] = self.body()
        summary = message or f"Training: {self.status['state']}" + (
            f", Runde {self.status['epoch']} von {self.status['epochs']}" if self.status["epoch"] else "")
        try:
            self.hub.commit(all_files, delete=list(delete), message=summary)
            return True
        except Exception as e:
            self.failures += 1
            if strict:
                raise
            self.log(f"warning: progress upload failed ({type(e).__name__}: {scrub(e)}); training continues")
            return False


# -------------------------------------------------------------- stop / resume
class StopWatch:
    """Asks, once per epoch, whether the run should end: a local flag file (set by
    the trainer Space's /stop) or `training/stop` in the model repo (set by the app)."""

    def __init__(self, hub: Hub, local_flag: str | None = None, log=print):
        self.hub, self.local_flag, self.log = hub, local_flag, log
        self.remote_seen = False

    def requested(self) -> bool:
        if self.local_flag and os.path.exists(self.local_flag):
            return True
        try:
            if self.hub.exists(STOP):
                self.remote_seen = True
                return True
        except Exception as e:
            self.log(f"warning: could not look for a stop request ({type(e).__name__})")
        return False

    def to_delete(self) -> list[str]:
        """The stop request is removed in the same commit that reports the stop."""
        return [STOP] if self.remote_seen else []


CHECKPOINT_FILES = ("last/model.pt", "last/meta.json", "train_state.json", "history.json")
BEST_FILES = ("best/model.pt", "best/meta.json")


def checkpoint_files(out: str, run: dict, with_best: bool) -> dict:
    """The files that let an interrupted run continue (`--resume-run`)."""
    files = {}
    for rel in CHECKPOINT_FILES + (BEST_FILES if with_best else ()):
        path = os.path.join(out, rel)
        if os.path.exists(path):
            files[f"{CHECKPOINT}/{rel}"] = path
    files[f"{CHECKPOINT}/run.json"] = json.dumps(run, ensure_ascii=False, indent=1).encode("utf-8")
    return files


def fetch_checkpoint(hub: Hub, dest: str) -> dict:
    """Download training/checkpoint/ into `dest`; returns run.json.  Raises
    FileNotFoundError when there is nothing to continue from."""
    names = [p for p in hub.list(CHECKPOINT + "/")]
    need = [f"{CHECKPOINT}/{r}" for r in CHECKPOINT_FILES + BEST_FILES + ("run.json",)]
    missing = [p for p in need if p not in names]
    if missing:
        raise FileNotFoundError("no complete checkpoint to continue from: " + ", ".join(missing))
    for p in need:
        hub.download(p, os.path.join(dest, p[len(CHECKPOINT) + 1:]))
    with open(os.path.join(dest, "run.json"), encoding="utf-8") as f:
        return json.load(f)

"""Documents: text -> pieces -> written pieces -> pages -> PDF, one at a time.

The flow is the app's page mode (web/js/generate/page-view.js): plan the document,
write the pieces (hw.sampling with the app's retry policy), prepare and lay them out,
write the pieces the layout flags once more and keep the better attempt, PDF."""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time

from .config import HERE

log = logging.getLogger("handschrift")

PAGES = os.path.join(HERE, "pages.mjs")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")          # 16 random bytes, base64url
BIAS = 0.4                                          # the app's Lesbarkeit default (web/js/generate/view.js)
RETRY_SALT = 0x2545F491                             # as page-view.js: the second attempt's own seed
PAPERS = ("liniert", "kariert", "blanko")
SIZES = ("klein", "mittel", "gross")
PENS = ("fineliner", "fueller", "bleistift")
SCHEMES = {"hell": "dark_on_light", "dunkel": "light_on_dark"}
NODE_TIMEOUT = 120
# A plan of 12,000 characters peaks at about 55 MB in node; parallel refused or
# racing calls must not fan out into many of them.
_NODE_SLOTS = threading.Semaphore(2)


class Refused(Exception):
    """A request that is answered with this one German line."""


class Stopped(Exception):
    """The job was stopped between two batches: the server shuts down or the time is up."""


def new_id() -> str:
    return secrets.token_urlsafe(16)


def node(cfg, request: dict) -> dict:
    # Only what node needs from the environment: HF_TOKEN and the like stay out.
    env = {k: os.environ[k] for k in ("PATH", "TZ", "LANG") if k in os.environ}
    with _NODE_SLOTS:
        p = subprocess.run([cfg.node, PAGES], input=json.dumps(request, ensure_ascii=False).encode(),
                           capture_output=True, timeout=NODE_TIMEOUT, env={**env, "HOME": cfg.data})
    if p.returncode:
        log.debug("pages.mjs stderr: %s", p.stderr.decode(errors="replace")[-400:])
        raise RuntimeError(f"pages.mjs {request.get('cmd')} failed")
    return json.loads(p.stdout)


def ink_json(ink) -> dict:
    pts = ink.points.astype(float).round(2).reshape(-1).tolist()
    return {"text": ink.text, "points": pts, "ok": bool(ink.meta.get("ok", True)),
            "problems": list(ink.meta.get("problems", []))}


@dataclasses.dataclass
class Job:
    id: str
    key: str                     # first 6 hex characters of the key's hash, for logs and the budget
    text: str
    plan: dict
    options: dict
    title: str
    state: str = "queued"        # queued | writing | retrying | layout | done | failed
    done: int = 0
    pages: int = 0
    times: dict = dataclasses.field(default_factory=dict)
    error: str = ""              # the German line for a failed job
    created: float = dataclasses.field(default_factory=time.time)
    finished: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    stop: threading.Event = dataclasses.field(default_factory=threading.Event)
    deadline: float = float("inf")                  # time.monotonic() after which the job gives up

    @property
    def total(self) -> int:
        return len(self.plan["pieces"])


def _check(job: Job) -> None:
    if job.stop.is_set():
        raise Stopped("stop")
    if time.monotonic() > job.deadline:
        raise Stopped("deadline")


def write_document(cfg, synth, job: Job, out: str) -> None:
    """The blocking part (a worker thread).  Writes the PDF to `out`.  Checks between
    batches whether to stop: one batch of 48 is the longest stretch that cannot be cut."""
    pieces = [p["text"] for p in job.plan["pieces"]]
    seed = secrets.randbits(31)
    t0 = time.perf_counter()
    job.state = "writing"
    inks = []
    for i in range(0, len(pieces), cfg.batch):
        _check(job)
        inks += synth.write(pieces[i:i + cfg.batch], bias=BIAS, seed=seed + i)
        job.done = len(inks)
    t1 = time.perf_counter()
    job.state = "retrying"
    xh = float(synth.meta.get("xh_model", 100.0))
    first = [ink_json(k) for k in inks]
    _check(job)
    flags = node(cfg, {"cmd": "flags", "xhModel": xh, "inks": first})["flags"]
    flagged = [i for i, n in enumerate(flags) if n]
    tries = [[k] for k in first]
    again_seed = (seed ^ RETRY_SALT) & 0x7FFFFFFF
    for b in range(0, len(flagged), cfg.batch):
        _check(job)
        part = flagged[b:b + cfg.batch]
        for i, k in zip(part, synth.write([pieces[i] for i in part], bias=BIAS, seed=again_seed + b)):
            tries[i].append(ink_json(k))
    t2 = time.perf_counter()
    _check(job)
    job.state = "layout"
    look = {"pen": job.options["stift"], "scheme": SCHEMES[job.options["farbe"]], "ink": "blueblack", "width": 0.32}
    settings = {"paper": job.options["papier"], "size": job.options["groesse"], "bias": BIAS, "seed": seed, "textLayer": True}
    res = node(cfg, {"cmd": "pdf", "out": out, "plan": job.plan, "inks": tries, "xhModel": xh,
                     "gapXh": synth.meta.get("gap_xh", [2.9, 0.8]), "sizeByBias": synth.meta.get("size_by_bias"),
                     "settings": settings, "look": look, "title": job.title})
    t3 = time.perf_counter()
    job.pages = int(res["pages"])
    job.times = {"write": round(t1 - t0, 2), "retry": round(t2 - t1, 2), "layout_pdf": round(t3 - t2, 2),
                 "flagged": len(flagged), "kept": res.get("kept", 0)}


class Store:
    """Finished PDFs on disk (<data>/pdf/<id>.pdf), the running ones in memory.  A job
    also leaves <id>.json (state and time, no text) until its PDF exists, so that after
    a restart its link can say what happened instead of a bare 404."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.dir = os.path.join(cfg.data, "pdf")
        os.makedirs(self.dir, exist_ok=True)
        self.jobs: dict[str, Job] = {}

    def path(self, doc_id: str) -> str | None:
        """The file of a well-formed id (whether or not it exists); None otherwise,
        before anything touches the file system."""
        if not isinstance(doc_id, str) or not ID_RE.match(doc_id):
            return None
        return os.path.join(self.dir, doc_id + ".pdf")

    def mark(self, doc_id: str, state: str) -> None:
        p = self.path(doc_id)
        if p is not None:
            with open(p[:-4] + ".json", "w") as f:
                json.dump({"state": state, "created": time.time()}, f)

    def unmark(self, doc_id: str) -> None:
        p = self.path(doc_id)
        if p is not None:
            self._remove(p[:-4] + ".json")

    def left_over(self, doc_id: str) -> str | None:
        """The state a job of an earlier run left (writing = interrupted, failed), or None."""
        p = self.path(doc_id)
        if p is None:
            return None
        try:
            with open(p[:-4] + ".json") as f:
                return str(json.load(f).get("state", "writing"))
        except (OSError, ValueError, AttributeError):
            return None

    def finished(self, doc_id: str) -> str | None:
        p = self.path(doc_id)
        if p is None:
            return None
        try:
            st = os.stat(p)
        except OSError:
            return None
        if time.time() - st.st_mtime > self.cfg.keep_days * 86400:
            self._remove(p)
            return None
        return p

    @staticmethod
    def _remove(p: str) -> None:
        try:
            os.remove(p)
        except OSError:
            pass

    def cleanup(self) -> int:
        """Files past their days go, then the oldest until the total fits the cap."""
        now, files, removed = time.time(), [], 0
        for name in os.listdir(self.dir):
            p = os.path.join(self.dir, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            stale_tmp = name.startswith(".") and now - st.st_mtime > 3600
            done_state = name.endswith(".json") and os.path.exists(p[:-5] + ".pdf")
            old = name.endswith((".pdf", ".json")) and now - st.st_mtime > self.cfg.keep_days * 86400
            if stale_tmp or done_state or old:
                self._remove(p)
                removed += 1
            elif name.endswith(".pdf"):
                files.append((st.st_mtime, st.st_size, p))
        total, cap = sum(f[1] for f in files), self.cfg.max_mb * 1e6
        for _, size, p in sorted(files):
            if total <= cap:
                break
            self._remove(p)
            total -= size
            removed += 1
        if removed:
            log.info("cleanup: %d files removed", removed)
        return removed


class Writer:
    """One document at a time, at most cfg.queue waiting behind it."""

    def __init__(self, cfg, store: Store, models):
        self.cfg, self.store, self.models = cfg, store, models
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.current: Job | None = None
        self.calls: dict[str, list[float]] = {}      # every tool call, per key
        self.docs: dict[str, list[float]] = {}       # accepted documents, per key
        self.reserved = 0                            # calls between reserve() and submit()/release()

    @property
    def busy(self) -> bool:
        return self.current is not None or not self.queue.empty()

    def waiting(self) -> int:
        return self.queue.qsize()

    @staticmethod
    def _recent(d: dict, key: str, now: float) -> list[float]:
        d[key] = [t for t in d.get(key, []) if now - t < 3600]
        return d[key]

    def count_call(self, key: str) -> None:
        """First thing in every tool call, before any work."""
        now = time.time()
        calls = self._recent(self.calls, key, now)
        if len(calls) >= self.cfg.calls:
            raise Refused("Über diesen Link kamen in der letzten Stunde zu viele Aufrufe. Bitte später noch einmal versuchen.")
        calls.append(now)

    def reserve(self, key: str) -> float:
        """Budget and queue place, taken before the text is planned; give it back with
        release() unless submit() follows.  Returns the token for release()."""
        now = time.time()
        docs = self._recent(self.docs, key, now)
        if len(docs) >= self.cfg.budget:
            raise Refused(f"Über diesen Link sind in der letzten Stunde schon {self.cfg.budget} PDFs entstanden. "
                          "Bitte später noch einmal versuchen.")
        if self.queue.qsize() + self.reserved >= self.cfg.queue:
            raise Refused("Gerade warten schon zu viele Texte aufs Schreiben. Bitte in ein paar Minuten noch einmal versuchen.")
        self.reserved += 1
        docs.append(now)
        return now

    def release(self, key: str, token: float) -> None:
        self.reserved -= 1
        with contextlib.suppress(ValueError):
            self.docs.get(key, []).remove(token)

    def submit(self, job: Job) -> None:
        self.reserved -= 1
        self.store.jobs[job.id] = job
        self.store.mark(job.id, "writing")
        self.queue.put_nowait(job)

    def stop_all(self) -> None:
        """Shutdown: the running job stops after its batch, the waiting ones never start."""
        for job in list(self.store.jobs.values()):
            job.stop.set()

    def position(self, job: Job) -> int:
        return next((i + 1 for i, j in enumerate(list(self.queue._queue)) if j is job), 0)

    async def run(self) -> None:
        while True:
            job = await self.queue.get()
            self.current = job
            try:
                await self._one(job)
            finally:
                self.current = None
                job.finished.set()

    async def _one(self, job: Job) -> None:
        out = self.store.path(job.id)
        tmp = os.path.join(self.store.dir, f".{job.id}.pdf")
        t = time.perf_counter()
        try:
            if job.stop.is_set():
                raise Stopped("stop")
            job.deadline = time.monotonic() + self.cfg.max_minutes * 60
            version, synth = await asyncio.to_thread(self.models.get)
            if synth is None:
                raise RuntimeError("no model")
            await asyncio.to_thread(write_document, self.cfg, synth, job, tmp)
            os.replace(tmp, out)
            job.state = "done"
            self.store.unmark(job.id)
            log.info("doc %s key=%s model=%s chars=%d pieces=%d pages=%d %s total=%.1fs", job.id[:4], job.key, version,
                     len(job.text), job.total, job.pages, " ".join(f"{k}={v}" for k, v in job.times.items()),
                     time.perf_counter() - t)
            await asyncio.to_thread(self.store.cleanup)        # the size cap holds after every document
        except Exception as e:
            job.state = "failed"
            Store._remove(tmp)
            if isinstance(e, Stopped) and str(e) == "stop":   # the state file stays "writing": interrupted
                job.error = "Der Server wurde neu gestartet, bevor das PDF fertig war. Bitte den Text noch einmal schicken."
            else:
                job.error = (f"Das Schreiben hat länger als {self.cfg.max_minutes:g} Minuten gedauert und wurde abgebrochen."
                             if isinstance(e, Stopped) else "Beim Schreiben ist etwas schiefgegangen. Bitte noch einmal versuchen.")
                self.store.mark(job.id, "failed")
            log.error("doc %s key=%s failed after %.1fs: %s %s", job.id[:4], job.key, time.perf_counter() - t,
                      type(e).__name__, e if isinstance(e, Stopped) else "")
            log.debug("doc failure", exc_info=True)
        finally:
            job.text = ""                              # nothing of the text stays in memory longer than needed
            job.plan = {"pieces": [None] * job.total, "paragraphs": []}

    def forget_old(self, keep: float = 3600) -> None:
        now = time.time()
        for k, j in list(self.store.jobs.items()):
            if j.finished.is_set() and now - j.created > keep:
                del self.store.jobs[k]
        for d in (self.calls, self.docs):
            for key in [key for key in d if not self._recent(d, key, now)]:
                del d[key]

"""Every published model is kept as its own version in the model repo.

    models/hw-rnn-model-<writer>-<YYYYMMDD>-<HHMMSS>/     (UTC)
        model.json, model.bin       what the web app downloads
        trained_on.json             which recordings it has seen
        version.json                its entry in the index (below)
        vergleich.png               the comparison image (if there was one)
        checkpoint/model.pt, ...    the PyTorch checkpoint (if there was one)
    models/index.json               all versions, newest first
    model.json, model.bin, trained_on.json, ...   (root) a copy of the newest version,
                                                   for app versions that know nothing else

models/index.json, format 1:

    {"format": 1, "updated": "2026-11-26T01:48:12Z",
     "models": [
       {"id": "hw-rnn-model-finn-20261126-014812",
        "path": "models/hw-rnn-model-finn-20261126-014812",
        "writer": "finn", "created": "2026-11-26T01:48:12Z",
        "lines": 143, "lines_only": false, "note": null,
        "rounds": 30, "best_round": 27, "score": -1.953,
        "sha256": "…", "bytes": 7712345}]}

`score` is the held-out score of the best round (negative log-likelihood per pen
point on the writer's real held-out lines; lower is better).  `lines` counts the
writer's capture-app lines the model was trained with; `rounds` is how many rounds
were run (null when unknown).

The index is always rebuilt from the version folders that are in the repo, so a
folder deleted by hand simply drops out of it at the next publish.  All writes go
through a hub (hw.progress.HfHub or LocalHub), one commit per publish.

Backfill (an older model, e.g. downloaded from the repo's history, as a version):

    from hw import models, progress
    hub = progress.HfHub(token)                      # or progress.LocalHub(folder) to try it
    models.add_version(hub, "old-model/", writer="finn", note="erstes Modell")

`old-model/` holds model.json, model.bin and trained_on.json (the latter
optional; its "date" becomes the version's time unless `created` is given).
"""
from __future__ import annotations

import datetime
import json
import os
import re

INDEX = "models/index.json"
PREFIX = "models/"
FORMAT = 1
ROOT_FILES = ("model.json", "model.bin", "trained_on.json")
_ID_RE = re.compile(r"^hw-rnn-model-([a-z0-9-]+)-(\d{8})-(\d{6})$")


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def _iso(t: datetime.datetime) -> str:
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value) -> datetime.datetime | None:
    if not value:
        return None
    try:
        t = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    return t.astimezone(datetime.timezone.utc).replace(microsecond=0)


def slug(writer: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", str(writer or "").lower()).strip("-")
    return s or "unbekannt"


def version_id(writer: str, created: datetime.datetime) -> str:
    return f"hw-rnn-model-{slug(writer)}-{created.astimezone(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')}"


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, 4) if v == v and abs(v) != float("inf") else None


def entry(vid: str, manifest: dict, trained_on: dict | None, *, writer: str, created: datetime.datetime,
          note: str | None = None, rounds: int | None = None) -> dict:
    """The index entry of one version."""
    trained_on = trained_on or {}
    tr = manifest.get("trained") or {}
    note = (str(note).strip()[:120] or None) if note else None
    return {"id": vid, "path": PREFIX + vid, "writer": writer, "created": _iso(created),
            "lines": trained_on.get("lines"), "lines_only": trained_on.get("lines_only"), "note": note,
            "rounds": rounds if rounds is not None else trained_on.get("rounds", trained_on.get("epochs")),
            "best_round": tr.get("epoch"), "score": _num(tr.get("val_real")),
            "sha256": manifest.get("sha256"), "bytes": manifest.get("bytes")}


def build_index(hub, extra: list[dict] = (), drop: set[str] = frozenset()) -> dict:
    """The index from what is in the repo: every models/<id>/ that has model.json,
    model.bin and version.json.  `extra`: entries being added in the same commit."""
    paths = set(hub.list(PREFIX))
    found = {}
    for p in paths:
        parts = p.split("/")
        if len(parts) == 3 and parts[2] == "version.json" and _ID_RE.match(parts[1]):
            vid = parts[1]
            if f"{PREFIX}{vid}/model.json" in paths and f"{PREFIX}{vid}/model.bin" in paths and vid not in drop:
                try:
                    e = json.loads(_read(hub, p))
                    if isinstance(e, dict) and e.get("id") == vid:
                        found[vid] = e
                except Exception as ex:                       # a damaged entry is left out, not fatal
                    print(f"note: {p} not readable ({type(ex).__name__}); left out of the index")
    for e in extra:
        found[e["id"]] = e
    models = sorted(found.values(), key=lambda e: (e.get("created") or "", e["id"]), reverse=True)
    return {"format": FORMAT, "updated": _iso(now_utc()), "models": models}


def _read(hub, path: str) -> bytes:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        with open(hub.download(path, os.path.join(tmp, "f")), "rb") as f:
            return f.read()


def _folder_files(folder: str) -> dict:
    out = {}
    for d, _, names in os.walk(folder):
        for n in names:
            full = os.path.join(d, n)
            out[os.path.relpath(full, folder).replace(os.sep, "/")] = full
    return out


def publish(hub, folder: str, *, writer: str, note: str | None = None, created: datetime.datetime | None = None,
            rounds: int | None = None, root: bool | None = None, message: str | None = None) -> dict:
    """One commit: `folder` (as prepared by scripts/publish_model.py: model.json, model.bin,
    trained_on.json, vergleich.png, checkpoint/, README.md ...) becomes models/<id>/, the
    index is rebuilt, and -- when this is the newest version, or root=True -- the repo
    root gets a copy.  Returns the index entry."""
    created = (created or now_utc()).astimezone(datetime.timezone.utc).replace(microsecond=0)
    files = _folder_files(folder)
    for need in ("model.json", "model.bin"):
        if need not in files:
            raise FileNotFoundError(f"{folder}: {need} missing")
    with open(files["model.json"], encoding="utf-8") as f:
        manifest = json.load(f)
    trained_on = {}
    if "trained_on.json" in files:
        with open(files["trained_on.json"], encoding="utf-8") as f:
            trained_on = json.load(f)
    vid = version_id(writer, created)
    e = entry(vid, manifest, trained_on, writer=writer, created=created, note=note, rounds=rounds)
    trained_on = dict(trained_on, version=vid)

    hub.ensure_repo()
    index = build_index(hub, extra=[e])
    newest = index["models"][0]["id"] == vid
    ops = {}
    for rel, src in files.items():
        if rel == "README.md":
            continue
        ops[f"{e['path']}/{rel}"] = src
    ops[f"{e['path']}/trained_on.json"] = json.dumps(trained_on, ensure_ascii=False, indent=1).encode()
    ops[f"{e['path']}/version.json"] = json.dumps(e, ensure_ascii=False, indent=1).encode()
    ops[INDEX] = json.dumps(index, ensure_ascii=False, indent=1).encode()
    if newest if root is None else root:
        for rel, src in files.items():
            ops[rel] = src
        ops["trained_on.json"] = ops[f"{e['path']}/trained_on.json"]
    hub.commit(ops, message=message or f"Modell {vid}")
    return e


def add_version(hub, folder: str, *, writer: str | None = None, created=None, note: str | None = None,
                rounds: int | None = None) -> dict:
    """Backfill: an existing model (a folder with model.json + model.bin, optionally
    trained_on.json, vergleich.png, checkpoint/) becomes a version.  `created` (a datetime or an
    ISO string) defaults to trained_on.json's "date"; `writer` to its "writer" or the main writer.
    The root copy is only replaced when this version is newer than every other."""
    from .config import MAIN_WRITER

    trained_on = {}
    p = os.path.join(folder, "trained_on.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            trained_on = json.load(f)
    when = created if isinstance(created, datetime.datetime) else parse_time(created or trained_on.get("date"))
    if when is None:
        raise ValueError("no time for this version: pass created=... (trained_on.json has no 'date')")
    return publish(hub, folder, writer=writer or trained_on.get("writer") or MAIN_WRITER, note=note,
                   created=when, rounds=rounds, message=f"Älteres Modell als Version aufgenommen ({note or 'ohne Notiz'})")


def rebuild_index(hub) -> dict:
    """Only the index, e.g. after deleting a version folder by hand."""
    index = build_index(hub)
    hub.commit({INDEX: json.dumps(index, ensure_ascii=False, indent=1).encode()}, message="Modellliste neu erstellt")
    return index

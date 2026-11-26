"""Loaders for the recordings on Hugging Face.

Every loader returns `Ink` objects in the pixel coordinates of the original
recording (y down) and, where the recording has them, per-point timestamps in
milliseconds (`ink.meta["t"]`, same length as the points).  Nothing is
rescaled or resampled here -- that is hw.prep's job -- so the raw recordings
stay the single source of truth.

Formats seen so far
-------------------
words-v1   parquet rows  dx/dy/eos, normalised so the word is 1 unit wide;
           `scale` (units per pixel) undoes that.                (Jan 2026)
words-raw  jsonl, strokes -> points {x,y,t,p,...}                (Jan 2026)
lines-sol  one json per line, strokes -> [{x,y,t,pressure,...}]  (Oct 2026)
inktrace   jsonl bundles, digit strings, strokes -> points       (Sep 2026)
hwline-v1  the format written by this project's own capture app (docs/schema)
"""
from __future__ import annotations

import glob
import json
import os

import numpy as np

from .ink import Ink

REPO_OWNER = "finnbusse"

# name -> (repo, format).  Order matters only for reporting.
LEGACY_SOURCES = {
    "handwriting-test": ("handwriting-test", "words-raw"),
    "handwriting-test-v2": ("handwriting-test-v2", "words-v1"),
    "handwriting-v1": ("handwriting-v1", "words-v1"),
    "v2testing": ("v2testing", "words-v1"),
    "v3testing": ("v3testing", "words-v1"),
    "handwritten-numbers-codex": ("handwritten-numbers-codex", "inktrace"),
    "handwriting-gpt6.1sol": ("handwriting-gpt6.1sol", "lines-sol"),
    "handwriting-fable": ("handwriting-fable", "hwline-v1"),
}

_PATTERNS = {
    "words-v1": ["data/*.parquet"],
    "words-raw": ["data/*.jsonl"],
    "lines-sol": ["raw/*.json"],
    "inktrace": ["inktrace/**/*.jsonl"],
    "hwline-v1": ["raw/v1/**/*.json"],
}


def download(repo: str, fmt: str, cache_dir: str, token: str | None = None) -> str:
    from huggingface_hub import snapshot_download

    local = os.path.join(cache_dir, repo.replace("/", "__"))
    snapshot_download(repo, repo_type="dataset", token=token, local_dir=local,
                      allow_patterns=_PATTERNS[fmt])
    return local


# --------------------------------------------------------------------- formats
def _as_array(v) -> np.ndarray:
    if isinstance(v, str):
        v = json.loads(v)
    return np.asarray(v, dtype=np.float64)


def load_words_v1(root: str, source: str) -> list[Ink]:
    import pandas as pd

    inks = []
    for f in sorted(glob.glob(os.path.join(root, "data", "*.parquet"))):
        df = pd.read_parquet(f)
        for r in df.itertuples(index=False):
            dx, dy, eos = _as_array(r.dx), _as_array(r.dy), _as_array(r.eos)
            scale = float(r.scale) if r.scale and r.scale > 0 else 1.0
            pts = np.stack([np.cumsum(dx) / scale, np.cumsum(dy) / scale, eos], axis=1)
            inks.append(Ink(pts, text=str(r.text), id=str(r.id), source=source, kind="word",
                            meta={"session": str(getattr(r, "session_id", "")),
                                  "created_at": str(getattr(r, "created_at", ""))}))
    return inks


def _ink_from_stroke_dicts(strokes, key_x="x", key_y="y", key_t="t", **kw) -> Ink | None:
    pts, ts, t_off = [], [], 0.0
    for s in strokes:
        p = s["points"] if isinstance(s, dict) else s
        if not p:
            continue
        xy = np.array([[q[key_x], q[key_y]] for q in p], dtype=np.float64)
        t = np.array([q.get(key_t, 0.0) or 0.0 for q in p], dtype=np.float64)
        eos = np.zeros(len(p))
        eos[-1] = 1.0
        pts.append(np.column_stack([xy, eos]))
        ts.append(t)
    if not pts:
        return None
    meta = kw.pop("meta", {})
    meta["t"] = np.concatenate(ts)
    return Ink(np.vstack(pts), meta=meta, **kw)


def load_words_raw(root: str, source: str) -> list[Ink]:
    inks = []
    for f in sorted(glob.glob(os.path.join(root, "data", "*.jsonl"))):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                ink = _ink_from_stroke_dicts(
                    r["strokes"], text=r["text"], id=str(r["id"]), source=source, kind="word",
                    meta={"session": r.get("session_id", ""), "created_at": r.get("created_at", ""),
                          "t_per_stroke": True})
                if ink is not None:
                    inks.append(ink)
    return inks


def load_lines_sol(root: str, source: str) -> list[Ink]:
    inks = []
    for f in sorted(glob.glob(os.path.join(root, "raw", "*.json"))):
        with open(f, encoding="utf-8") as fh:
            r = json.load(fh)
        ink = _ink_from_stroke_dicts(
            r["strokes"], text=r["transcription"].strip(), id=f"sol-{r['id']}", source=source,
            kind="line", meta={"session": "sol", "created_at": r.get("save_date_time", "")})
        if ink is not None:
            inks.append(ink)
    return inks


def load_inktrace(root: str, source: str) -> list[Ink]:
    inks = []
    for f in sorted(glob.glob(os.path.join(root, "inktrace", "**", "*.jsonl"), recursive=True)):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                task = r.get("task", {})
                ink = _ink_from_stroke_dicts(
                    r["strokes"], text=str(task.get("target", "")), id=str(r["id"]), source=source,
                    kind="word", meta={"session": r.get("session_id", ""),
                                       "created_at": r.get("created_at", ""),
                                       "task_kind": task.get("kind", "")})
                if ink is not None and ink.text:
                    inks.append(ink)
    return inks


def load_hwline_v1(root: str, source: str, include_flagged: bool = False,
                   pointer_types: tuple[str, ...] = ("pen",), writer: str | None = None) -> list[Ink]:
    """Recordings of this project's capture app: one hwline/v1 JSON per line
    (docs/schema/hwline_v1.schema.json), under raw/v1/<writer>/<session>/….
    With `writer` only that writer's lines are returned."""
    inks = []
    for f in sorted(glob.glob(os.path.join(root, "raw", "v1", "**", "*.json"), recursive=True)):
        with open(f, encoding="utf-8") as fh:
            r = json.load(fh)
        if r.get("schema") != "hwline/v1":
            continue
        if r.get("status") != "accepted" and not include_flagged:
            continue
        if r.get("pointer", {}).get("type", "pen") not in pointer_types:
            continue
        if writer is not None and r.get("writer_id") != writer:
            continue
        pts, ts = [], []
        for st in r["strokes"]:
            n = len(st["x"])
            if n == 0:
                continue
            eos = np.zeros(n)
            eos[-1] = 1.0
            pts.append(np.column_stack([np.asarray(st["x"], dtype=np.float64),
                                        np.asarray(st["y"], dtype=np.float64), eos]))
            ts.append(np.asarray(st["t"], dtype=np.float64))
        if not pts:
            continue
        inks.append(Ink(np.vstack(pts), text=r["text"], id=str(r["id"]), source=source, kind="line",
                        meta={"t": np.concatenate(ts), "session": r.get("session_id", ""),
                              "created_at": r.get("created_at", ""),
                              "prompt_id": r.get("prompt", {}).get("id", ""),
                              "writer": r.get("writer_id", ""),
                              "flags": r.get("flags", []),
                              # what the writer removed (counts; removed strokes are never stored)
                              "edits": r.get("edits") or {}}))
    return inks


LOADERS = {
    "words-v1": load_words_v1,
    "words-raw": load_words_raw,
    "lines-sol": load_lines_sol,
    "inktrace": load_inktrace,
    "hwline-v1": load_hwline_v1,
}


CAPTURE_SOURCES = ("handwriting-fable",)
LINE_SOURCES = ("handwriting-gpt6.1sol",) + CAPTURE_SOURCES   # whole lines (October 2025 and the capture app)


def load_all(cache_dir: str, token: str | None = None, extra: dict | None = None,
             fetch: bool = True, writer: str | None = None, legacy: bool = True,
             lines_only: bool = False) -> list[Ink]:
    """Load every known recording.  `extra` maps source name -> (repo, format).
    `writer` selects one writer of the capture app's recordings; the older
    datasets carry no writer and are included unless `legacy` is False.
    `lines_only` keeps the sources that hold whole written lines and leaves out
    the early sets of single words and digit strings."""
    sources = {k: v for k, v in LEGACY_SOURCES.items()
               if (legacy or k in CAPTURE_SOURCES) and (not lines_only or k in LINE_SOURCES)}
    sources.update(extra or {})
    inks: list[Ink] = []
    for name, (repo, fmt) in sources.items():
        full = repo if "/" in repo else f"{REPO_OWNER}/{repo}"
        local = os.path.join(cache_dir, full.replace("/", "__"))
        if fetch:
            try:
                local = download(full, fmt, cache_dir, token)
            except Exception as e:                       # e.g. the capture repo does not exist yet
                if name not in CAPTURE_SOURCES:
                    raise
                print(f"note: {full} not available ({type(e).__name__}); continuing without it")
        if not os.path.isdir(local):
            continue
        if fmt == "hwline-v1":
            inks.extend(load_hwline_v1(local, name, writer=writer))
        else:
            inks.extend(LOADERS[fmt](local, name))
    return inks

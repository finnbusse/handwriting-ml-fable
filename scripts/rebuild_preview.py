"""(Re)build the Dataset Viewer preview of `handwriting-fable` from the raw recordings.

    python scripts/rebuild_preview.py             # add previews that are missing
    python scripts/rebuild_preview.py --all       # redo every preview

Normally the capture app writes the preview itself when it uploads a line:

    preview/<writer>/<session>/<prompt>__<id>.png     the line as an image
    preview/<writer>/<session>/metadata.jsonl         one row per line of that session

This script produces exactly the same layout from the raw files under raw/v1/,
as a safety net (older lines, a failed preview upload, a changed look).  The
raw recordings are never modified.  Needs HF_TOKEN with write access.
"""
import argparse
import collections
import io
import json
import os
import sys

import numpy as np
from huggingface_hub import CommitOperationAdd, HfApi, snapshot_download

DATASET = "handwriting-fable"
# Columns of metadata.jsonl -- keep in sync with web/js/preview.js
COLUMNS = ["file_name", "text", "writer", "date", "prompt", "status", "notes", "strokes", "points",
           "seconds", "pen_rate_hz", "pen", "paper"]


DOT_PX = 1.5   # strokes smaller than this (canvas px) are drawn as dots
DOT_PT = 2.4   # their diameter in points


def render(strokes, height_px: int = 150) -> bytes:
    """One written line as a PNG (dark ink on white), cropped to the ink."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    xs = np.concatenate([np.asarray(s["x"], dtype=float) for s in strokes])
    ys = np.concatenate([np.asarray(s["y"], dtype=float) for s in strokes])
    w, h = max(xs.max() - xs.min(), 1.0), max(ys.max() - ys.min(), 1.0)
    pad = 0.35 * h + 4
    aspect = (w + 2 * pad) / (h + 2 * pad)
    fig = plt.figure(figsize=(min(max(height_px * aspect, 300), 2400) / 100, height_px / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    for s in strokes:
        x, y = np.asarray(s["x"], dtype=float), -np.asarray(s["y"], dtype=float)
        if len(x) == 1 or max(np.ptp(x), np.ptp(y)) < DOT_PX:
            # a full stop or an i-dot is often a tap of a few milliseconds that hardly
            # moves; drawn as a line it would be invisible
            ax.plot([x.mean()], [y.mean()], "o", color="#16233f", ms=DOT_PT, mew=0)
        else:
            ax.plot(x, y, "-", color="#16233f", lw=1.3, solid_capstyle="round", solid_joinstyle="round")
    ax.set_xlim(xs.min() - pad, xs.max() + pad)
    ax.set_ylim(-ys.max() - pad, -ys.min() + pad)
    ax.set_aspect("equal")
    ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


def meta_row(file_name: str, rec: dict) -> dict:
    strokes = [s for s in rec["strokes"] if len(s["x"])]
    guides = rec.get("guides") or {}
    return {
        "file_name": file_name,
        "text": rec["text"],
        "writer": rec.get("writer_name") or rec.get("writer_id", ""),
        "date": rec.get("created_at", "")[:19].replace("T", " "),
        "prompt": rec.get("prompt", {}).get("id", ""),
        "status": rec.get("status", ""),
        "notes": ", ".join(rec.get("flags", [])),
        "strokes": len(strokes),
        "points": sum(len(s["x"]) for s in strokes),
        "seconds": round((strokes[-1]["t"][-1] - strokes[0]["t"][0]) / 1000.0, 1),
        "pen_rate_hz": round(float(rec.get("pointer", {}).get("rate_hz") or 0.0), 1),
        "pen": guides.get("pen") or "",
        "paper": guides.get("paper") or "",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="render every line again, not only missing ones")
    ap.add_argument("--cache", default="data_cache")
    args = ap.parse_args()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    if not token:
        sys.exit("HF_TOKEN is not set")
    api = HfApi(token=token)
    repo = f"{api.whoami()['name']}/{DATASET}"
    files = sorted(s.rfilename for s in api.dataset_info(repo).siblings)
    raw = [f for f in files if f.startswith("raw/v1/") and f.endswith(".json")]
    have = {f for f in files if f.startswith("preview/") and f.endswith(".png")}
    todo_sessions = collections.defaultdict(list)
    for f in raw:
        todo_sessions[os.path.dirname(f)].append(f)
    local = snapshot_download(repo, repo_type="dataset", token=token, allow_patterns=["raw/v1/**/*.json"],
                              local_dir=os.path.join(args.cache, repo.replace("/", "__")))
    ops, added = [], 0
    for session, paths in sorted(todo_sessions.items()):
        folder = "preview/" + session[len("raw/v1/"):]
        missing = [p for p in paths if f"{folder}/{os.path.basename(p)[:-5]}.png" not in have]
        if not missing and not args.all:
            continue
        rows = []
        for p in sorted(paths):
            with open(os.path.join(local, p), encoding="utf-8") as fh:
                rec = json.load(fh)
            if rec.get("schema") != "hwline/v1" or not any(len(s["x"]) for s in rec["strokes"]):
                continue
            name = os.path.basename(p)[:-5] + ".png"
            rows.append(meta_row(name, rec))
            if args.all or p in missing:
                ops.append(CommitOperationAdd(f"{folder}/{name}",
                                              io.BytesIO(render([s for s in rec["strokes"] if len(s["x"])]))))
                added += 1
        rows.sort(key=lambda r: r["date"])
        text = "".join(json.dumps({k: r[k] for k in COLUMNS}, ensure_ascii=False) + "\n" for r in rows)
        ops.append(CommitOperationAdd(f"{folder}/metadata.jsonl", io.BytesIO(text.encode("utf-8"))))
    if not ops:
        print(f"preview is complete ({len(raw)} lines)")
        return
    api.create_commit(repo, ops, commit_message=f"Vorschau ergänzt ({added} Bilder)", repo_type="dataset")
    print(json.dumps({"repo": repo, "lines": len(raw), "images_written": added}))


if __name__ == "__main__":
    main()

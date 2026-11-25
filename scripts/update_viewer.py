"""Keep the Hugging Face Dataset Viewer table of `handwriting-fable` up to date.

    python scripts/update_viewer.py            # rebuild if the recordings changed
    python scripts/update_viewer.py --force

The capture app uploads one raw JSON file per written line (raw/v1/...).  Those
files are the source of truth and are never touched here.  For browsing, this
script renders every line to a small image and writes one table,
`viewer/train.parquet`, that the Dataset Viewer shows: image, text, writer,
date and a few numbers.  Needs HF_TOKEN with write access.
"""
import argparse
import datetime
import hashlib
import io
import json
import os
import sys

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download, snapshot_download

DATASET = "handwriting-fable"
TABLE = "viewer/train.parquet"
STATE = "viewer/state.json"

CARD = """---
language:
- de
- en
tags:
- handwriting
- stroke-data
- stylus
configs:
- config_name: default
  data_files:
  - split: train
    path: viewer/train.parquet
---

# handwriting-fable

Stiftaufnahmen aus der Web-App des Projekts *Handschrift*: Jede Zeile wurde mit
einem Stift von Hand abgeschrieben.

**Zum Durchsehen** zeigt der Dataset Viewer die Tabelle `viewer/train.parquet`:
ein Vorschaubild jeder Zeile, der geschriebene Text, das Kürzel der schreibenden
Person, das Datum und ein paar Kennzahlen. Die Tabelle wird automatisch aus den
Rohdaten erzeugt.

**Die Rohdaten** liegen unverändert unter

```
raw/v1/<schreiber>/<sitzung>/<vorlage>__<id>.json    eine Zeile pro Datei
```

im Format `hwline/v1`: unverarbeitete Stiftkoordinaten mit Zeitstempeln, Druck
und Neigung, dazu der Text. Alle Aufbereitung (Größe, Grundlinie, Abtastung)
passiert erst beim Training. Das Format ist im Projekt-Repository unter
`docs/schema/hwline_v1.schema.json` beschrieben.
"""


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
        if len(x) == 1:
            ax.plot(x, y, ".", color="#16233f", ms=2.5)
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


def row(path: str, rec: dict) -> dict:
    strokes = [s for s in rec["strokes"] if len(s["x"])]
    n = sum(len(s["x"]) for s in strokes)
    t0, t1 = strokes[0]["t"][0], strokes[-1]["t"][-1]
    letters = max(len(rec["text"].replace(" ", "")), 1)
    return {
        "image": {"bytes": render(strokes), "path": os.path.basename(path).replace(".json", ".png")},
        "text": rec["text"],
        "writer": rec.get("writer_name") or rec.get("writer_id", ""),
        "date": rec.get("created_at", "")[:19].replace("T", " "),
        "prompt": rec.get("prompt", {}).get("id", ""),
        "status": rec.get("status", ""),
        "notes": ", ".join(rec.get("flags", [])),
        "strokes": len(strokes),
        "points": n,
        "points_per_letter": round(n / letters, 1),
        "seconds": round((t1 - t0) / 1000.0, 1),
        "pen_rate_hz": float(rec.get("pointer", {}).get("rate_hz") or 0.0),
        "pen": rec.get("guides", {}).get("pen", "") or "",
        "paper": rec.get("guides", {}).get("paper", "") or "",
        "file": path,
    }


FEATURES = {
    "image": {"_type": "Image"},
    **{k: {"dtype": "string", "_type": "Value"} for k in
       ("text", "writer", "date", "prompt", "status", "notes", "pen", "paper", "file")},
    **{k: {"dtype": "int32", "_type": "Value"} for k in ("strokes", "points")},
    **{k: {"dtype": "float32", "_type": "Value"} for k in ("points_per_letter", "seconds", "pen_rate_hz")},
}
ORDER = ["image", "text", "writer", "date", "prompt", "status", "notes", "strokes", "points",
         "points_per_letter", "seconds", "pen_rate_hz", "pen", "paper", "file"]


def to_table(rows: list[dict]) -> pa.Table:
    types = {"image": pa.struct([("bytes", pa.binary()), ("path", pa.string())]),
             "strokes": pa.int32(), "points": pa.int32(),
             "points_per_letter": pa.float32(), "seconds": pa.float32(), "pen_rate_hz": pa.float32()}
    arrays = [pa.array([r[k] for r in rows], type=types.get(k, pa.string())) for k in ORDER]
    table = pa.Table.from_arrays(arrays, names=ORDER)
    meta = {"info": {"features": {k: FEATURES[k] for k in ORDER}}}
    return table.replace_schema_metadata({"huggingface": json.dumps(meta)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--cache", default="data_cache")
    args = ap.parse_args()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    if not token:
        sys.exit("HF_TOKEN is not set")
    api = HfApi(token=token)
    repo = f"{api.whoami()['name']}/{DATASET}"
    files = sorted(s.rfilename for s in api.dataset_info(repo).siblings
                   if s.rfilename.startswith("raw/v1/") and s.rfilename.endswith(".json"))
    digest = hashlib.sha256("\n".join(files).encode()).hexdigest()
    try:
        with open(hf_hub_download(repo, STATE, repo_type="dataset", token=token), encoding="utf-8") as f:
            old = json.load(f).get("files_sha256")
    except Exception:
        old = None
    if old == digest and not args.force:
        print(f"viewer table is up to date ({len(files)} lines)")
        return
    local = snapshot_download(repo, repo_type="dataset", token=token, allow_patterns=["raw/v1/**/*.json"],
                              local_dir=os.path.join(args.cache, repo.replace("/", "__")))
    rows = []
    for path in files:
        with open(os.path.join(local, path), encoding="utf-8") as f:
            rec = json.load(f)
        if rec.get("schema") == "hwline/v1" and rec.get("strokes"):
            rows.append(row(path, rec))
    rows.sort(key=lambda r: r["date"], reverse=True)
    os.makedirs("viewer_tmp", exist_ok=True)
    if rows:
        pq.write_table(to_table(rows), "viewer_tmp/train.parquet", compression="zstd")
    state = {"files_sha256": digest, "lines": len(rows),
             "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    with open("viewer_tmp/state.json", "w", encoding="utf-8") as f:
        json.dump(state, f)
    with open("viewer_tmp/README.md", "w", encoding="utf-8") as f:
        f.write(CARD)
    from huggingface_hub import CommitOperationAdd
    ops = [CommitOperationAdd(STATE, "viewer_tmp/state.json"), CommitOperationAdd("README.md", "viewer_tmp/README.md")]
    if rows:
        ops.append(CommitOperationAdd(TABLE, "viewer_tmp/train.parquet"))
    api.create_commit(repo, ops, commit_message=f"Übersicht aktualisiert ({len(rows)} Zeilen)", repo_type="dataset")
    print(json.dumps({"repo": repo, "lines": len(rows),
                      "table_kb": os.path.getsize("viewer_tmp/train.parquet") // 1024 if rows else 0}))


if __name__ == "__main__":
    main()

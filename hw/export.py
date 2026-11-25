"""Export a trained checkpoint for the browser.

    python -m hw.export runs/v1/best web/model

Writes
    model.json   manifest: tensors (name, shape, byte offset), charset,
                 normalisation, sampling defaults
    model.bin    all weights as little-endian float16, in manifest order

float16 halves the download (about 7.6 MB) and costs nothing audible in
quality: the largest weights are far below the float16 range limit and the
relative precision (3-4 significant digits) is finer than the sampling noise.
`--dtype float32` keeps full precision.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os

import numpy as np

from .model import load_state
from .sampling import SENTINEL

FORMAT = 1
ORDER = [
    "lstm1.W_xh", "lstm1.W_ci", "lstm1.W_cf", "lstm1.W_co", "lstm1.b_i", "lstm1.b_f", "lstm1.b_c", "lstm1.b_o",
    "window.alpha.weight", "window.alpha.bias", "window.beta.weight", "window.beta.bias",
    "window.k.weight", "window.k.bias",
    "lstm2.W_xh", "lstm2.W_ci", "lstm2.W_cf", "lstm2.W_co", "lstm2.b_i", "lstm2.b_f", "lstm2.b_c", "lstm2.b_o",
    "lstm3.W_xh", "lstm3.W_ci", "lstm3.W_cf", "lstm3.W_co", "lstm3.b_i", "lstm3.b_f", "lstm3.b_c", "lstm3.b_o",
    "mixture.pi.weight", "mixture.pi.bias", "mixture.mu.weight", "mixture.mu.bias",
    "mixture.sd.weight", "mixture.sd.bias", "mixture.ro.weight", "mixture.ro.bias",
    "mixture.eos.weight", "mixture.eos.bias",
]


def export(model_dir: str, out_dir: str, dtype: str = "float16") -> dict:
    state = load_state(os.path.join(model_dir, "model.pt"))
    with open(os.path.join(model_dir, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    if set(state) != set(ORDER):
        raise ValueError(f"unexpected tensors: {sorted(set(state) ^ set(ORDER))}")
    np_dtype = {"float16": "<f2", "float32": "<f4"}[dtype]
    tensors, blobs, offset, worst = [], [], 0, 0.0
    for name in ORDER:
        a = state[name].detach().cpu().numpy().astype(np.float32)
        q = a.astype(np_dtype)
        if not np.isfinite(q).all():
            raise ValueError(f"{name}: values overflow {dtype}")
        worst = max(worst, float(np.abs(q.astype(np.float32) - a).max()))
        raw = q.tobytes()
        tensors.append({"name": name, "shape": list(a.shape), "offset": offset, "length": int(a.size)})
        blobs.append(raw)
        offset += len(raw)
    blob = b"".join(blobs)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "model.bin"), "wb") as f:
        f.write(blob)
    manifest = {
        "format": FORMAT,
        "dtype": dtype,
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "hidden": int(state["lstm1.W_ci"].shape[0]),
        "window_components": int(state["window.k.bias"].shape[0]),
        "mixtures": int(state["mixture.pi.bias"].shape[0]),
        "alphabet": len(meta["charset"]) + 1,
        "charset": meta["charset"],
        "mu": meta["mu"],
        "std": meta["std"],
        "xh_model": meta.get("xh_model"),
        "gap_xh": meta.get("gap_xh"),
        "sentinel": SENTINEL,
        "trained": {k: meta[k] for k in ("epoch", "val_real", "val_composed", "data", "base") if k in meta},
        "tensors": tensors,
    }
    with open(os.path.join(out_dir, "model.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return {"bytes": len(blob), "max_abs_error": worst, "tensors": len(tensors)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--dtype", default="float16", choices=["float16", "float32"])
    args = ap.parse_args(argv)
    print(json.dumps(export(args.model_dir, args.out_dir, args.dtype)))


if __name__ == "__main__":
    main()

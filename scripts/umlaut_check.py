"""Does the model set its dots?  Counts dot strokes in generated text.

    python scripts/umlaut_check.py runs/v3/best

Writes texts full of ä ö ü (two dots each) and i j (one dot each) and counts
the short strokes that sit above the small letters.  A model that has learned
the umlauts reaches roughly the expected number; one that still writes "a" for
"ä" stays near the number of i-dots alone.
"""
import argparse
import json

import numpy as np
import torch
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo root, for "hw"

from hw import prep
from hw.ink import contact_sheet
from hw.sampling import Synthesizer

TEXTS = [
    "Fünf Äpfel und zwölf Nüsse", "Übung macht den Meister", "Können wir später üben?",
    "Schöne Grüße aus Köln", "Die Tür öffnet sich für Gäste", "Mädchen hören fröhliche Töne",
    "Über Österreich nach Zürich", "Käse, Müsli und Brötchen", "Wir müssen früher gehen",
    "Die Bäume blühen schön", "Ärger über späte Züge", "Zwölf Vögel flogen südwärts",
]


def dots(ink, xh_model: float) -> int:
    p = ink.points.copy()
    p[:, :2] /= xh_model
    return prep.dot_strokes(ink.copy(points=p, kind="line"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--bias", type=float, default=0.4)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    torch.set_num_threads(1)
    syn = Synthesizer.load(args.model_dir)
    inks = syn.write(TEXTS, bias=args.bias, seed=3)
    xh = float(syn.meta["xh_model"])
    found = sum(dots(i, xh) for i in inks)
    umlauts = sum(t.count(c) for t in TEXTS for c in "äöüÄÖÜ")
    ij = sum(t.count(c) for t in TEXTS for c in "ij")
    print(json.dumps({"epoch": syn.meta.get("epoch"), "dot_strokes_found": found,
                      "expected_if_umlauts_learned": 2 * umlauts + ij, "expected_if_not": ij,
                      "umlauts_in_texts": umlauts, "failed_lines": sum(not i.meta["ok"] for i in inks)}))
    if args.out:
        for i in inks:
            i.points[:, :2] /= xh
        contact_sheet(inks, args.out, colors=["tab:blue"] * len(inks), row_height=0.95)


if __name__ == "__main__":
    main()

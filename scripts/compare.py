"""Side-by-side check: does the model write like the writer?

    python scripts/compare.py runs/v1/best --out runs/v1/compare.png

Top: real held-out lines of the writer (black) with the model's attempt at the
same text right below (blue).  Bottom: sentences the writer never recorded.
Also prints how many samples finished cleanly.
"""
import argparse
import json

import numpy as np
import torch

from hw import dataset, sources
from hw.ink import contact_sheet
from hw.sampling import Synthesizer

NEW_TEXTS = [
    "Heute ist ein schöner Tag",
    "Viele Grüße und bis bald!",
    "Fünf Äpfel, zwölf Nüsse",
    "Können wir uns um 15:30 treffen?",
    "Das Wetter wird morgen besser",
    "Übung macht den Meister",
    "Straße, Fuß, weiß, groß",
    "Zimmer 204, 3. Stock",
    "The quick brown fox jumps",
    "Bitte nicht vergessen: Milch kaufen",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--out", default="compare.png")
    ap.add_argument("--bias", type=float, default=0.8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--cache", default="data_cache")
    ap.add_argument("--threads", type=int, default=1)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)

    syn = Synthesizer.load(args.model_dir)
    with open("artifacts/base/stats.json") as f:
        base_stats = json.load(f)
    raw = sources.load_all(args.cache, fetch=False)
    raw, _ = dataset.apply_exclusions(raw, dataset.load_exclusions())
    inks, report = dataset.calibrate_cached(raw, base_stats, args.cache)
    _, val = dataset.split(inks)
    real = []
    for line in [i for i in val if i.kind == "line"]:
        real += dataset.line_chunks(line) or [line]
    real = real[:8]

    texts = [r.text for r in real] + NEW_TEXTS
    gen = syn.write(texts, bias=args.bias, seed=args.seed)
    xh = syn.meta["xh_model"]
    for g in gen:
        g.points[:, :2] /= xh
    sheet, titles, colors = [], [], []
    for r, g in zip(real, gen):
        sheet += [r, g]
        titles += ["ECHT: " + r.text, "Modell: " + r.text]
        colors += ["k", "tab:blue"]
    for g in gen[len(real):]:
        sheet.append(g)
        titles.append("Modell (neuer Text): " + g.text)
        colors.append("tab:blue")
    contact_sheet(sheet, args.out, titles=titles, colors=colors, row_height=1.0)
    done = [g.meta["finished"] for g in gen]
    ppc = [len(g) / max(len(g.text.replace(" ", "")), 1) for g in gen]
    print(json.dumps({"samples": len(gen), "finished": int(sum(done)),
                      "points_per_char_median": round(float(np.median(ppc)), 1), "out": args.out}))


if __name__ == "__main__":
    main()

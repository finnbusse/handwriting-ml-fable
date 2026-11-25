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


def style_stats(inks):
    """A few numbers that describe a hand: letter size relations, width, slant,
    spacing, how often the pen lifts.  Inks in xh units."""
    from hw import prep

    xh, tall, width, slant, gaps, lifts = [], [], [], [], [], []
    for ink in inks:
        probe = ink.copy(kind="line")
        a, b, _ = prep.baseline(probe)
        h = prep.letter_heights(probe, a, b)
        x = prep.fit_xheight(h, ink.text, 2.6)
        if np.isfinite(x) and x > 0:
            xh.append(x)
            hi = h[h > 1.6 * x]
            if len(hi):
                tall.append(float(np.median(hi)) / x)
        letters = max(len(ink.text.replace(" ", "")), 1)
        width.append(float(np.ptp(ink.points[:, 0])) / max(len(ink.text), 1))
        lifts.append(float(ink.points[:, 2].sum()) / letters)
        d = np.diff(ink.points[:, :2], axis=0)[ink.points[:-1, 2] < 0.5]
        steep = d[np.abs(d[:, 1]) > 2.0 * np.abs(d[:, 0])]
        if len(steep) > 10:
            slant.append(float(np.degrees(np.arctan(np.median(-steep[:, 0] / steep[:, 1])))))
        n_sp = ink.text.count(" ")
        if n_sp:
            strokes = probe.strokes()
            reach, jumps = strokes[0][:, 0].max(), []
            for st in strokes[1:]:
                jumps.append(float(st[:, 0].min() - reach))
                reach = max(reach, float(st[:, 0].max()))
            gaps += [j for j in sorted(jumps, reverse=True)[:n_sp] if j > 0.2]
    med = lambda v: round(float(np.median(v)), 2) if v else None
    return {"x_height": med(xh), "ascender_ratio": med(tall), "width_per_char": med(width),
            "slant_deg": med(slant), "word_gap": med(gaps), "strokes_per_letter": med(lifts)}


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
                      "ok_first_try": int(sum(g.meta.get("attempt", 1) == 1 and g.meta.get("ok", True) for g in gen)),
                      "points_per_char_median": round(float(np.median(ppc)), 1), "out": args.out}))
    # the hand in numbers: the writer's real lines vs what the model wrote for the same texts
    print("echt:  ", json.dumps(style_stats(real)))
    print("modell:", json.dumps(style_stats(gen[: len(real)])))


if __name__ == "__main__":
    main()

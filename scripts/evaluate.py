"""How good is a model?  A fixed, repeatable set of measurements.

    python scripts/evaluate.py runs/v8/best --out runs/v8/eval

Everything is measured on free-running samples at the app's default setting,
that is on what the writer actually sees, not on likelihood (which mostly
follows how narrow the predicted spread is, see hw/train.py):

  first_try      share of pieces that came out clean at the first attempt
  dots           dot strokes set as a share of what the texts call for
                 (i, j and two per umlaut); capital umlauts separately
  final_stop     share of sentences ending in "." whose dot was written
  size           stroke height and ink length per letter, generated / real
  style          ascender ratio, width per character, slant, word gap, pen
                 lifts per letter: generated minus real, same texts
  same_text      how much the ink length varies when one text is written
                 several times (pieces of a page should match in size)

It prints one JSON object, writes it to <out>/metrics.json and draws sheets to
look at.  Numbers of two models are comparable when both were evaluated with
the same seeds; the spread between seeds of one model is reported too.
"""
import argparse
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo root, for "hw"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))                    # the other scripts

from hw import dataset, prep  # noqa: E402
from hw.config import MAIN_WRITER  # noqa: E402
from hw.ink import contact_sheet  # noqa: E402
from hw.sampling import Synthesizer  # noqa: E402
from hw.train import load_corpus_inks  # noqa: E402
from compare import style_stats  # noqa: E402
from umlaut_check import TEXTS as UMLAUT_TEXTS, dots as count_dots  # noqa: E402

COMMON = [
    "Heute ist ein schöner Tag.", "Wir sehen uns morgen in der Schule.", "Kannst du mir bitte helfen?",
    "Das Wetter wird am Wochenende besser.", "Ich habe den Bus leider verpasst.", "Viele Grüße und bis bald!",
    "Der Kuchen steht auf dem Tisch.", "Hast du die Hausaufgaben gemacht?", "Wir treffen uns nach dem Training.",
    "Meine Schwester kommt später nach.", "Bitte denk an den Schlüssel.", "Das war wirklich eine gute Idee.",
    "Am Abend lese ich noch ein Buch.", "Die Kinder spielen draußen im Garten.", "Ruf mich an, wenn du Zeit hast.",
    "Das Fenster lässt sich nicht öffnen.",
]
RARE = [
    "Treffen um 14:30 Uhr am Bahnhof", "Zimmer 204, 3. Stock, Tür 7", "Gesamt: 126 € + 19 % Steuer",
    "Quittung Nr. 5890 vom 17.03.", "Yoga, Xylophon und Quiz am Mittwoch", "Jahr 2026: Urlaub in Venedig?",
    "Preis: 9,99 € (nur heute!)", "Clara, Emil, Nora und Otto kommen.", "Kapitel 12, Seite 348 bis 351",
    "Lies \"Der Zauberberg\" bis Freitag.", "The quick brown fox jumps over it.", "Rechne: 48 + 37 = 85",
]
CAPITAL_UMLAUTS = ["Ärger im Ölhafen", "Über Österreich nach Ägypten", "Äpfel, Öl und Ölfarbe", "Übung und Ärger",
                   "Ölkanne, Äste, Übermut", "Ärzte aus Österreich"]
REPEAT = ["Wir sehen uns morgen in der Schule.", "Das Wetter wird am Wochenende besser."]


def to_xh(ink, xh_model):
    """Generated ink in x-heights with the baseline at y = 0 (it starts wherever the first letter starts)."""
    pts = np.column_stack([ink.points[:, :2] / xh_model, ink.points[:, 2]])
    a, b, _ = prep.baseline(ink.copy(points=pts, kind="line"))
    pts[:, 1] -= a * pts[:, 0] + b
    return ink.copy(points=pts)


def stroke_heights(ink):
    return [float(np.ptp(ink.points[s, 1])) for s in prep.stroke_slices(ink.points) if s.stop - s.start >= 4]


def ink_per_letter(ink):
    p = ink.points
    d = np.hypot(*np.diff(p[:, :2], axis=0).T)[p[:-1, 2] < 0.5]
    return float(d.sum()) / max(len(ink.text.replace(" ", "")), 1)


def expected_dots(text):
    return sum(text.count(c) for c in "ij") + 2 * sum(text.count(c) for c in "äöüÄÖÜ")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model_dir")
    ap.add_argument("--out", default=None, help="folder for metrics.json and the sheets (default: <model_dir>/eval)")
    ap.add_argument("--bias", type=float, default=0.4, help="the app's default legibility setting")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--cache", default="data_cache")
    ap.add_argument("--base", default="artifacts/base")
    ap.add_argument("--writer", default=MAIN_WRITER)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()
    if args.threads:
        torch.set_num_threads(args.threads)
    out = args.out or os.path.join(args.model_dir, "eval")
    os.makedirs(out, exist_ok=True)

    syn = Synthesizer.load(args.model_dir)
    xh_model = float(syn.meta["xh_model"])
    write = lambda texts, seed, tries=1: [to_xh(i, xh_model) for i in syn.write(texts, bias=args.bias, seed=seed, tries=tries)]

    # the writer's real lines: always the lines-only corpus, so that every model is compared with the same lines
    with open(os.path.join(args.base, "stats.json")) as f:
        base_stats = json.load(f)
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    inks, _ = load_corpus_inks(args.cache, base_stats, token, fetch=not args.no_fetch, writer=args.writer,
                               lines_only=True)
    _, val = dataset.split(inks)
    real = [i for i in val if i.kind == "line"]
    real_all = [i for i in inks if i.kind == "line" and i.source in ("handwriting-fable",)] or real

    seeds = list(range(args.seeds))
    per_seed = []
    sheets = {}
    for seed in seeds:
        m = {}
        first = write(COMMON + RARE + UMLAUT_TEXTS, 100 + seed)
        m["first_try"] = float(np.mean([i.meta["ok"] for i in first]))
        m["first_try_common"] = float(np.mean([i.meta["ok"] for i in first[:len(COMMON)]]))
        m["first_try_rare"] = float(np.mean([i.meta["ok"] for i in first[len(COMMON):len(COMMON) + len(RARE)]]))
        uml = first[len(COMMON) + len(RARE):]
        m["dots"] = sum(count_dots(i, 1.0) for i in uml) / sum(expected_dots(t) for t in UMLAUT_TEXTS)
        caps = write(CAPITAL_UMLAUTS, 200 + seed)
        m["dots_capital_umlauts"] = sum(count_dots(i, 1.0) for i in caps) / sum(expected_dots(t) for t in CAPITAL_UMLAUTS)
        stops = [i for i in first if i.text.endswith(".")]
        m["final_stop"] = float(np.mean([dataset.has_final_period(i.copy(kind="line")) for i in stops]))
        gen = write([r.text for r in real], 300 + seed, tries=3)
        g, r = style_stats(gen), style_stats(real)
        m["style"] = {k: (None if g[k] is None or r[k] is None else round(g[k] - r[k], 3)) for k in g}
        m["stroke_height_ratio"] = float(np.median(sum(map(stroke_heights, gen), [])) /
                                         np.median(sum(map(stroke_heights, real), [])))
        m["ink_per_letter_ratio"] = float(np.median([ink_per_letter(i) for i in gen]) /
                                          np.median([ink_per_letter(i) for i in real]))
        rep = []
        for text in REPEAT:
            lengths = np.log([ink_per_letter(i) for i in write([text] * 8, 400 + seed, tries=3)])
            rep.append(float(lengths.std()))
        m["same_text_spread"] = float(np.mean(rep))
        per_seed.append(m)
        if seed == 0:
            sheets = {"common": first[:len(COMMON)], "rare": first[len(COMMON):len(COMMON) + len(RARE)],
                      "umlauts": uml + caps, "real_vs_model": [x for pair in zip(real, gen) for x in pair]}

    keys = [k for k in per_seed[0] if k != "style"]
    result = {"model": os.path.abspath(args.model_dir), "bias": args.bias, "seeds": len(seeds),
              "epoch": syn.meta.get("epoch"), "val_real": syn.meta.get("val_real"), "sd_shift": syn.meta.get("sd_shift"),
              "lines_only": syn.meta.get("lines_only"), "real_lines_compared": len(real)}
    for k in keys:
        v = np.array([m[k] for m in per_seed])
        result[k] = round(float(v.mean()), 4)
        result[k + "_sd"] = round(float(v.std()), 4)
    result["style"] = {k: (None if any(m["style"][k] is None for m in per_seed)
                           else round(float(np.mean([m["style"][k] for m in per_seed])), 3)) for k in per_seed[0]["style"]}
    with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    for name, group in sheets.items():
        colors = None
        if name == "real_vs_model":
            colors = ["black", "tab:blue"] * (len(group) // 2)
        contact_sheet(group, os.path.join(out, f"{name}.png"), colors=colors or ["tab:blue"] * len(group),
                      row_height=0.8, titles=[i.text for i in group])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

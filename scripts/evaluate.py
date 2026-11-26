"""How good is a model?  A fixed, repeatable set of measurements.

    python scripts/evaluate.py runs/v8/best --out runs/v8/eval

Everything is measured on free-running samples at the app's default setting,
written piece by piece exactly as the app does it (hw/page.py: split_pieces),
that is on what the writer actually sees, not on likelihood (which mostly
follows how narrow the predicted spread is, see hw/train.py):

  first_try      share of pieces that came out sound at the first attempt
  drift          share of first attempts whose pen slid below the line
  word_shift     share of words the layout has to move more than 0.3 x-heights
                 to set them on the line
  dots           dot strokes set as a share of what the texts call for
                 (i, j and two per umlaut); capital umlauts separately
  final_stop     share of sentences ending in "." whose dot was written
  delivered      after the retries of the app (up to three attempts, up to six
                 while the best one is sound and only lacks dots, best one
                 kept; hw/sampling.py: TRIES, TRIES_FOR_DOTS): share of pieces
                 still faulty, share still lacking a dot, mean attempts
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

from hw import dataset, page, prep  # noqa: E402
from hw.config import MAIN_WRITER  # noqa: E402
from hw.ink import Ink, contact_sheet  # noqa: E402
from hw.sampling import Synthesizer, expected_dots  # noqa: E402
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
REPEAT = ["Wir sehen uns morgen", "Das Wetter wird am Sonntag"]
PROSE = [
    "Im Bewusstsein seiner Verantwortung vor Gott und den Menschen, von dem Willen beseelt, als gleichberechtigtes "
    "Glied in einem vereinten Europa dem Frieden der Welt zu dienen, hat sich das Deutsche Volk kraft seiner "
    "verfassungsgebenden Gewalt dieses Grundgesetz gegeben.",
    "Der Parlamentarische Rat hat festgestellt, dass das Grundgesetz in der Woche vom 16. bis 22. Mai 1949 durch die "
    "Volksvertretungen von mehr als zwei Dritteln der beteiligten deutschen Länder angenommen worden ist.",
    "Liebe Oma, vielen Dank für das schöne Paket zum Geburtstag. Ich habe mich riesig darüber gefreut, vor allem über "
    "den Kuchen und die Bücher. In der Uni läuft es gerade ganz gut, nächste Woche schreiben wir die erste Klausur.",
    "Am Wochenende fahre ich mit Freunden an die Ostsee, hoffentlich spielt das Wetter mit. Wir wollen zelten, "
    "grillen und abends am Strand sitzen. Wie geht es dir und dem Garten? Blühen die Rosen schon?",
    "Einkaufen: Brot, Butter, Käse, sechs Eier, Äpfel, Joghurt und Zahnpasta. Termin beim Zahnarzt am Donnerstag "
    "um 15:30 Uhr nicht vergessen. Die Vorlesung über Quantenphysik fällt morgen aus.",
]


def pieces_of(texts):
    """The texts cut into the pieces the app writes, and for every text the indices of its pieces."""
    flat, index = [], []
    for t in texts:
        ps = [p for para in page.split_pieces(t) for p in para]
        index.append(list(range(len(flat), len(flat) + len(ps))))
        flat += ps
    return flat, index


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
    # tries=None: the app's retries (Synthesizer.write's default policy)
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

    norm = syn.charset.normalize
    groups = {"common": COMMON, "rare": RARE, "umlauts": UMLAUT_TEXTS, "prose": PROSE}
    texts = [norm(t) for g in groups.values() for t in g]
    flat, index = pieces_of(texts)
    bounds = np.cumsum([0] + [len(g) for g in groups.values()])
    in_group = {name: [k for t in range(bounds[j], bounds[j + 1]) for k in index[t]] for j, name in enumerate(groups)}
    caps_flat, _ = pieces_of([norm(t) for t in CAPITAL_UMLAUTS])
    drifted = lambda i: any(p.startswith("drift") for p in i.meta["problems"])

    seeds = list(range(args.seeds))
    per_seed = []
    sheets = {}
    for seed in seeds:
        m = {}
        first = write(flat, 100 + seed)
        ok = np.array([i.meta["ok"] for i in first])
        m["first_try"] = float(ok.mean())
        for name in ("common", "rare", "prose"):
            m[f"first_try_{name}"] = float(ok[in_group[name]].mean())
        m["drift"] = float(np.mean([drifted(i) for i in first]))
        shifts = []
        for i in first:
            st = page.straighten(Ink(i.points, text=norm(i.text), kind="line", source="generated"))
            shifts += [abs(level) for w, level in page.levelled_words(st) if len(w.text) >= 3]
        m["word_shift"] = float(np.mean(np.array(shifts) > 0.3))
        uml = [first[k] for k in in_group["umlauts"]]
        m["dots"] = sum(min(count_dots(i, 1.0), expected_dots(i.text)) for i in uml) / sum(expected_dots(i.text) for i in uml)
        caps = write(caps_flat, 200 + seed)
        m["dots_capital_umlauts"] = (sum(min(count_dots(i, 1.0), expected_dots(i.text)) for i in caps)
                                     / sum(expected_dots(i.text) for i in caps))
        stops = [i for i in first if i.text.endswith(".")]
        m["final_stop"] = float(np.mean([dataset.has_final_period(i.copy(kind="line")) for i in stops]))
        best = write(flat, 100 + seed, tries=None)
        m["delivered_faulty"] = float(np.mean([not i.meta["ok"] for i in best]))
        m["delivered_missing_dots"] = float(np.mean([i.meta["missing_dots"] > 0 for i in best]))
        m["attempts"] = float(np.mean([i.meta["attempt"] for i in best]))
        gen = write([r.text for r in real], 300 + seed, tries=None)
        g, r = style_stats(gen), style_stats(real)
        m["style"] = {k: (None if g[k] is None or r[k] is None else round(g[k] - r[k], 3)) for k in g}
        m["stroke_height_ratio"] = float(np.median(sum(map(stroke_heights, gen), [])) /
                                         np.median(sum(map(stroke_heights, real), [])))
        m["ink_per_letter_ratio"] = float(np.median([ink_per_letter(i) for i in gen]) /
                                          np.median([ink_per_letter(i) for i in real]))
        rep = []
        for text in REPEAT:
            lengths = np.log([ink_per_letter(i) for i in write([text] * 8, 400 + seed, tries=None)])
            rep.append(float(lengths.std()))
        m["same_text_spread"] = float(np.mean(rep))
        per_seed.append(m)
        if seed == 0:
            sheets = {"common": [first[k] for k in in_group["common"]], "rare": [first[k] for k in in_group["rare"]],
                      "umlauts": uml + caps, "prose": [first[k] for k in in_group["prose"]][:40],
                      "real_vs_model": [x for pair in zip(real, gen) for x in pair]}

    keys = [k for k in per_seed[0] if k != "style"]
    result = {"model": os.path.abspath(args.model_dir), "bias": args.bias, "seeds": len(seeds),
              "epoch": syn.meta.get("epoch"), "val_real": syn.meta.get("val_real"), "sd_shift": syn.meta.get("sd_shift"),
              "pieces": len(flat), "lines_only": syn.meta.get("lines_only"), "real_lines_compared": len(real)}
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

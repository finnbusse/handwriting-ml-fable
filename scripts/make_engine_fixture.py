"""Reference results for the browser engine.

    python scripts/make_engine_fixture.py runs/v2/best tests/engine/fixtures

Exports the checkpoint the way the browser will load it (float16) and records,
with exactly those weights, what the reference implementation produces for a
few texts and one page layout.  The JavaScript engine has to reproduce these
numbers (see docs/SPEC.md 2.6).  The output directory is not kept in git.
"""
import argparse
import json
import os

import numpy as np
import torch
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo root, for "hw"

from hw import dataset, page, prep
from hw.charset import Charset
from hw.export import export, load_exported
from hw.ink import Ink, from_offsets
from hw.model import SynthesisNetwork
from hw.reference import make_draws, sample_reference
from hw.sampling import SENTINEL, Synthesizer, skipped_chars

TEXTS = ["Hallo Welt", "Viele Grüße aus Köln!", "Zimmer 204, 3. Stock", "The quick brown fox"]
SHORT_TEXTS = ["a", "B.", "an.", "und", "Ja!", "Ok"]      # MIN_STEPS_PER_CHAR keeps them from stopping at once
SPLIT_CASES = [
    "Morgen schreiben wir die Klausur im Hörsaal B.", "Der Zug kommt pünktlich um acht Uhr an.", "a", "Ja!", "Ok gut",
    "Abc Donaudampfschifffahrt",
    "ab Donaudampfschifffahrtsgesellschaft und", "Hallo\nB.\n\nDas ist ein ganz normaler Satz ohne Ende.",
    "Viele Grüße aus dem schönen Köln am Rhein", "x y z a b c d e f g h i j k l m n o p q r s",
]
# skipped_chars on made-up attention: (normalized text, peak per character, character per point)
SKIP_CASES = [
    ("abcd", [1.0, 0.09, 0.8, 0.9], [0] * 10 + [1] * 2 + [2] * 10 + [3] * 10),          # weak peak alone
    ("abcd", [1.0, 0.12, 0.8, 0.9], [0] * 10 + [1] * 18 + [2] * 10 + [3] * 10),         # 0.12, stayed 1.8 x median
    ("abcd", [1.0, 0.12, 0.8, 0.9], [0] * 10 + [1] * 17 + [2] * 10 + [3] * 10),         # 0.12, not long enough
    ("ab cd", [1.0, 0.9, 0.14, 0.8, 0.13], [0] * 10 + [1] * 10 + [2] * 40 + [3] * 12 + [4] * 20 + [5] * 9),
    ("abc", [0.5, 0.06, 0.5], [0] * 5 + [2] * 5),                                       # never visited, weak
]
NORMALIZE_CASES = [
    "Hallo Welt", "  viele   Leerzeichen\tund\nUmbruch ", "„Zitat“ und ‚einfach‘", "Gedanken – Strich — lang",
    "Café, naïve, señor, Ångström", "Preis: 3,50 € (inkl. 19 % MwSt.)", "E-Mail: info@beispiel.de", "a{b}c<d>e|f\\g~h^i",
    "GROẞ und groß", "Drei Punkte… fertig", "Emoji 🙂 und 中文 fallen weg", "A\u0308pfel (zerlegtes Ä)", "100 $ = 92 €", "x² + y³",
]
PAGE_TEXT = ("Heute ist ein schöner Tag, und morgen wird es noch besser.\nBis bald!\n"
             "Fünf Äpfel und zwölf Nüsse für die Gäste in Österreich, Zürich und Köln.")


def r(a, n=6):
    return np.round(np.asarray(a, dtype=np.float64), n).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--bias", type=float, default=0.8)
    args = ap.parse_args()
    torch.set_num_threads(1)

    info = export(args.model_dir, args.out_dir, "float16")
    state, manifest = load_exported(args.out_dir)
    charset = Charset(manifest["charset"])
    model = SynthesisNetwork(charset.size)
    model.load_state_dict(state)
    model.eval()
    syn = Synthesizer(model, charset, manifest["mu"], manifest["std"], {"xh_model": manifest["xh_model"]})
    xh = float(manifest["xh_model"])

    def run(text, seed, trace=0):
        norm = charset.normalize(text)
        tokens = charset.encode(norm + SENTINEL)
        draws = make_draws(60 * len(tokens) + 100, seed)
        res = sample_reference(model, tokens, draws, args.bias, len(SENTINEL), trace=trace)
        n = len(res["offsets"])
        ink = syn._finish(text, res["offsets"], {"finished": res["finished"], "tail_step": res["tail_step"],
                                                  "char_peak": torch.from_numpy(res["char_peak"]), "where": res["where"]})
        rec = {"text": text, "normalized": norm, "tokens": tokens, "seed": seed,
               "draws": r(draws[:n], 9), "offsets": r(res["offsets"]), "finished": res["finished"],
               "tail_step": res["tail_step"], "char_peak": r(res["char_peak"]), "trace": res["trace"],
               "where": [int(v) for v in ink.meta["where"]],
               "skipped": skipped_chars(norm, res["char_peak"][:len(norm)], ink.meta["where"]),
               "finish": {"points": r(ink.points, 4), "ok": ink.meta["ok"], "problems": ink.meta["problems"]}}
        return rec, ink

    samples = [run(t, 100 + k, trace=3)[0] for k, t in enumerate(TEXTS)]
    samples += [run(t, 200 + k, trace=3)[0] for k, t in enumerate(SHORT_TEXTS)]

    # page layout: pieces -> straighten -> words -> placement
    paragraphs = page.split_pieces("\n".join(charset.normalize(l) for l in PAGE_TEXT.split("\n")))
    pieces, rows, k = [], [], 0
    for para in paragraphs:
        row = []
        for text in para:
            rec, ink = run(text, 500 + k)
            k += 1
            judged = syn.judge(ink.copy(meta={**ink.meta, "problems": list(ink.meta["problems"])}))
            ink.points[:, :2] /= xh
            a, b, _ = prep.baseline(ink.copy(kind="line"))
            st = page.straighten(ink)
            words = page.levelled_words(st)
            rec.update(baseline={"a": a, "b": b}, straight=r(st.points, 5), dots=prep.dot_strokes(ink),
                       judge={"missing_dots": judged.meta["missing_dots"], "stray_depth": judged.meta["stray_depth"],
                              "ok": judged.meta["ok"]},
                       words=[{"text": w.text, "points": len(w), "x0": float(w.points[:, 0].min()),
                               "x1": float(w.points[:, 0].max()), "level": level} for w, level in words])
            pieces.append(rec)
            row.append(st)
        rows.append(row)
    gap = tuple(manifest.get("gap_xh") or (2.9, 0.8))
    gap_draws = np.random.default_rng(7).standard_normal(len(pieces)).tolist()
    pg = page.layout(rows, gap=gap, gap_draws=gap_draws)
    fixture = {
        "about": "reference results for web/js/engine, see scripts/make_engine_fixture.py",
        "model_sha256": manifest["sha256"], "bias": args.bias, "sentinel": SENTINEL, "xh_model": xh,
        "charset": manifest["charset"],
        "normalize": [{"in": t, "out": charset.normalize(t), "tokens": charset.encode(charset.normalize(t))}
                      for t in NORMALIZE_CASES],
        "samples": samples,
        "split": [{"in": t, "out": page.split_pieces(t)} for t in SPLIT_CASES],
        "skip": [{"norm": t, "peak": pk, "where": w, "skipped": skipped_chars(t, np.array(pk, dtype=np.float32), np.array(w))}
                 for t, pk, w in SKIP_CASES],
        "page": {"text": PAGE_TEXT, "paragraphs": paragraphs, "pieces": pieces, "gap": list(gap),
                 "gap_draws": gap_draws, "width": pg.width, "line_height": 6.5, "margin": 3.0, "top": 5.0,
                 "lines": pg.lines, "height": pg.height,
                 "words": [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in w.items()} for w in pg.words],
                 "points": r(pg.ink.points, 4)},
    }
    with open(os.path.join(args.out_dir, "fixture.json"), "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False)
    print(json.dumps({"export": info, "samples": [(s["text"], len(s["offsets"]), s["finished"], s["finish"]["ok"]) for s in samples],
                      "page_words": len(pg.words), "page_lines": pg.lines,
                      "fixture_kb": os.path.getsize(os.path.join(args.out_dir, "fixture.json")) // 1024}, ensure_ascii=False))


if __name__ == "__main__":
    main()

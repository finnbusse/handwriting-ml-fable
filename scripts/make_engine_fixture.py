"""Reference results for the browser engine.

    python scripts/make_engine_fixture.py runs/v2/best tests/web/fixtures

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

from hw import dataset, page, prep
from hw.charset import Charset
from hw.export import export, load_exported
from hw.ink import Ink, from_offsets
from hw.model import SynthesisNetwork
from hw.reference import make_draws, sample_reference
from hw.sampling import SENTINEL, Synthesizer

TEXTS = ["Hallo Welt", "Viele Grüße aus Köln!", "Zimmer 204, 3. Stock", "The quick brown fox"]
PAGE_TEXT = "Heute ist ein schöner Tag, und morgen wird es noch besser.\nBis bald!"


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
                                                  "char_peak": torch.from_numpy(res["char_peak"])})
        rec = {"text": text, "normalized": norm, "tokens": tokens, "seed": seed,
               "draws": r(draws[:n], 9), "offsets": r(res["offsets"]), "finished": res["finished"],
               "tail_step": res["tail_step"], "char_peak": r(res["char_peak"]), "trace": res["trace"],
               "finish": {"points": r(ink.points, 4), "ok": ink.meta["ok"], "problems": ink.meta["problems"]}}
        return rec, ink

    samples = [run(t, 100 + k, trace=3)[0] for k, t in enumerate(TEXTS)]

    # page layout: pieces -> straighten -> words -> placement
    paragraphs = page.split_pieces("\n".join(charset.normalize(l) for l in PAGE_TEXT.split("\n")))
    pieces, rows, k = [], [], 0
    for para in paragraphs:
        row = []
        for text in para:
            rec, ink = run(text, 500 + k)
            k += 1
            ink.points[:, :2] /= xh
            a, b, _ = prep.baseline(ink.copy(kind="line"))
            st = page.straighten(ink)
            words = page.piece_words(st)
            rec.update(baseline={"a": a, "b": b}, straight=r(st.points, 5),
                       words=[{"text": w.text, "points": len(w), "x0": float(w.points[:, 0].min()),
                               "x1": float(w.points[:, 0].max())} for w in words])
            pieces.append(rec)
            row.append(st)
        rows.append(row)
    gap = tuple(manifest.get("gap_xh") or (2.9, 0.8))
    gap_draws = np.random.default_rng(7).standard_normal(len(pieces)).tolist()
    pg = page.layout(rows, gap=gap, gap_draws=gap_draws)
    fixture = {
        "about": "reference results for web/js/engine, see scripts/make_engine_fixture.py",
        "model_sha256": manifest["sha256"], "bias": args.bias, "sentinel": SENTINEL, "xh_model": xh,
        "samples": samples,
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

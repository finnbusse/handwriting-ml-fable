#!/usr/bin/env python3
"""Verify web/prompts/de-core.json against docs/SPEC.md section 2.4 and print coverage.

Usage: python3 scripts/check_prompts.py [path/to/de-core.json]
Exit code 1 on any violation.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from hw.charset import DEFAULT_CHARSET  # noqa: E402

N_PROMPTS, BLOCK = 160, 20
MIN_LEN, MAX_LEN = 18, 40
LOWER = "abcdefghijklmnopqrstuvwxyzäöüß"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ"
DIGITS = "0123456789"
PUNCT = '.,!?:-()"\''
SIGNS = ";/%+=&@€"
RARE = "#*_[]"
RARE_CAPS = "QXY"  # one occurrence is enough in blocks 1-2

# 60 most frequent German letter pairs (lowercase, within words).
TOP_PAIRS = ("en er ch de ei nd te in ie ge es un ne st re he be se ng di ha it ti is an ar le ur au sc "
             "ra hr ni nt al ns ma el em ke lt ri rs ic ll sp ve ro la ld ab mi ze wi ru ss da si li ol").split()
COMBOS = "sch ch ck tz st sp ei ie eu äu au ung heit keit lich".split()


def counts(texts):
    return Counter("".join(texts))


def pair_counts(texts):
    c = Counter()
    for t in texts:
        for w in t.lower().replace("-", " ").split():
            w = "".join(ch for ch in w if ch in LOWER)
            for i in range(len(w) - 1):
                c[w[i:i + 2]] += 1
    return c


def sub_counts(texts, subs):
    low = [t.lower() for t in texts]
    return {s: sum(t.count(s) for t in low) for s in subs}


def line(label, chars, c):
    return f"  {label:<8}" + " ".join(f"{ch}:{c.get(ch, 0)}" for ch in chars)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "web" / "prompts" / "de-core.json"
    errs = []

    def need(c, chars, minimum, where, exceptions=None):
        for ch in chars:
            m = (exceptions or {}).get(ch, minimum)
            if c.get(ch, 0) < m:
                errs.append(f"{where}: '{ch}' occurs {c.get(ch, 0)}x, need >= {m}")

    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("set") != "de-core@1":
        errs.append(f"set must be 'de-core@1', got {data.get('set')!r}")
    prompts = data.get("prompts", [])
    if len(prompts) != N_PROMPTS:
        errs.append(f"expected {N_PROMPTS} prompts, found {len(prompts)}")

    seen = set()
    for i, p in enumerate(prompts):
        if set(p) != {"id", "text", "lang", "block"}:
            errs.append(f"#{i + 1}: fields must be exactly id,text,lang,block (got {sorted(p)})")
        if p.get("id") != f"de-core-{i + 1:04d}":
            errs.append(f"#{i + 1}: bad id {p.get('id')!r}")
        if p.get("block") != i // BLOCK + 1:
            errs.append(f"#{i + 1}: block {p.get('block')!r}, expected {i // BLOCK + 1}")
        if p.get("lang") not in ("de", "en"):
            errs.append(f"#{i + 1}: lang {p.get('lang')!r}")
        t = p.get("text", "")
        if not MIN_LEN <= len(t) <= MAX_LEN:
            errs.append(f"#{i + 1}: length {len(t)} outside {MIN_LEN}-{MAX_LEN}: {t!r}")
        bad = sorted({ch for ch in t if ch not in DEFAULT_CHARSET})
        if bad:
            errs.append(f"#{i + 1}: characters outside alphabet {bad}: {t!r}")
        if t != t.strip() or "  " in t:
            errs.append(f"#{i + 1}: stray whitespace: {t!r}")
        if t in seen:
            errs.append(f"#{i + 1}: duplicate text {t!r}")
        seen.add(t)

    texts = [p.get("text", "") for p in prompts]
    langs = [p.get("lang") for p in prompts]
    b12, b100 = texts[:40], texts[:100]
    c12, c100, call = counts(b12), counts(b100), counts(texts)

    # English share, spread over all blocks
    n_en = langs.count("en")
    if not 12 <= n_en <= 20:
        errs.append(f"english lines: {n_en}, expected about 10 % (12-20)")
    for b in range(N_PROMPTS // BLOCK):
        k = langs[b * BLOCK:(b + 1) * BLOCK].count("en")
        if not 1 <= k <= 4:
            errs.append(f"block {b + 1}: {k} english lines, expected 1-4 (spread out)")

    # blocks 1-2
    need(c12, LOWER + UPPER, 2, "blocks1-2", {ch: 1 for ch in RARE_CAPS})
    need(c12, DIGITS, 3, "blocks1-2")
    need(c12, PUNCT, 2, "blocks1-2")
    # first 100
    need(c100, LOWER, 12, "first100")
    need(c100, UPPER, 3, "first100")
    need(c100, DIGITS, 10, "first100")
    need(c100, SIGNS, 3, "first100")
    letters = Counter({ch: n for ch, n in c100.items() if ch.lower() in LOWER})
    lcount = Counter()
    for ch, n in letters.items():
        lcount[ch.lower()] += n
    if lcount.most_common(1)[0][0] != "e":
        errs.append(f"first100: most frequent letter is {lcount.most_common(1)[0][0]!r}, expected 'e'")
    pc100 = pair_counts(b100)
    assert len(set(TOP_PAIRS)) == 60, len(set(TOP_PAIRS))
    weak = {p: pc100.get(p, 0) for p in TOP_PAIRS if pc100.get(p, 0) < 5}
    for p, n in weak.items():
        errs.append(f"first100: pair '{p}' occurs {n}x, need >= 5")
    sc = sub_counts(b100, COMBOS)
    for s, n in sc.items():
        if n < 5:
            errs.append(f"first100: combination '{s}' occurs {n}x, need >= 5")
    # rare signs only in blocks 6-8
    c68 = counts(texts[100:])
    need(c68, RARE, 2, "blocks6-8")
    for ch in RARE:
        if c100.get(ch, 0):
            errs.append(f"'{ch}' must not appear in the first 100 lines")

    # ---- report ----
    print(f"{path.name}: {len(prompts)} prompts, {n_en} english, lengths "
          f"{min(map(len, texts))}-{max(map(len, texts))}")
    for label, c, chars_ in (("blocks 1-2 (40 lines)", c12, None), ("first 100", c100, None), ("all 160", call, None)):
        print(label)
        print(line("lower", LOWER, c))
        print(line("upper", UPPER, c))
        print(line("digits", DIGITS, c))
        print(line("punct", PUNCT + " ", c).replace(" :", " :", 1))
        print(line("signs", SIGNS + RARE, c))
    print("pairs (first 100): weakest of top 60: " + " ".join(
        f"{p}:{n}" for p, n in sorted(((p, pc100.get(p, 0)) for p in TOP_PAIRS), key=lambda x: x[1])[:12]))
    print("weak/missing pairs (<5): " + (" ".join(f"{p}:{n}" for p, n in weak.items()) or "none"))
    print("combos (first 100): " + " ".join(f"{s}:{n}" for s, n in sc.items()))
    if errs:
        print(f"\nFAIL: {len(errs)} violation(s)")
        for e in errs:
            print("  - " + e)
        return 1
    print("\nOK: all rules satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main())

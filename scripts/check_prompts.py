#!/usr/bin/env python3
"""Verify web/prompts/de-core.json (de-core@2, 800 prompts) against docs/SPEC.md section 2.4
and print coverage.

Rules: all earlier rules for blocks 1-2 and the first 100 lines; ids continuous to 0800,
40 blocks of 20, charset and length for every line, no duplicate or near-duplicate lines
(pairs that involve a line of blocks 9-40; blocks 1-8 are frozen), and per-block soft
constraints for blocks 9-40: >= 10 umlaut/ß characters, >= 2 lines with digits,
>= 2 questions/exclamations, English lines spread (1-4 per block, never adjacent).

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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hw.charset import DEFAULT_CHARSET  # noqa: E402
from build_prompts import near_duplicate, norm_key, word_set  # noqa: E402

N_PROMPTS, BLOCK = 800, 20
N_OLD = 160            # blocks 1-8 of de-core@1, kept unchanged
SET_NAME = "de-core@2"
UMLAUTS = "äöüÄÖÜß"
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
    if data.get("set") != SET_NAME:
        errs.append(f"set must be {SET_NAME!r}, got {data.get('set')!r}")
    prompts = data.get("prompts", [])
    if len(prompts) != N_PROMPTS:
        errs.append(f"expected {N_PROMPTS} prompts, found {len(prompts)}")

    seen = set()
    if len(prompts) // BLOCK * BLOCK != len(prompts):
        errs.append(f"{len(prompts)} prompts do not form complete blocks of {BLOCK}")
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
    if not 12 <= langs[:N_OLD].count("en") <= 20:
        errs.append(f"english lines in blocks 1-8: {langs[:N_OLD].count('en')}, expected 12-20")
    if not 0.06 * len(texts) <= n_en <= 0.11 * len(texts):
        errs.append(f"english lines: {n_en}, expected about 8 % ({int(0.06 * len(texts))}-{int(0.11 * len(texts))})")
    for b in range(len(texts) // BLOCK):
        k = langs[b * BLOCK:(b + 1) * BLOCK].count("en")
        if not 1 <= k <= 4:
            errs.append(f"block {b + 1}: {k} english lines, expected 1-4 (spread out)")
    for i in range(1, len(langs)):
        if langs[i] == "en" and langs[i - 1] == "en":
            errs.append(f"#{i + 1}: two english lines in a row")
    en_pos = [i for i, l in enumerate(langs) if l == "en"]
    for a, b in zip(en_pos, en_pos[1:]):
        if b - a > 30:
            errs.append(f"english lines #{a + 1} and #{b + 1} are {b - a} lines apart (spread evenly)")

    # duplicates and near-duplicates (normalised: case, punctuation, spacing); frozen pairs skipped
    keys, wsets = [norm_key(t) for t in texts], [word_set(t) for t in texts]
    byk = {}
    for i, k in enumerate(keys):
        byk.setdefault(k, []).append(i)
    for k, idx in byk.items():
        if len(idx) > 1 and idx[-1] >= N_OLD:
            errs.append("duplicate lines ignoring case/punctuation: " + ", ".join(f"#{i + 1}" for i in idx))
    for j in range(N_OLD, len(texts)):
        for i in range(j):
            if keys[i] != keys[j] and near_duplicate(wsets[i], wsets[j]):
                errs.append(f"#{j + 1} is a near-duplicate of #{i + 1}: {texts[j]!r} / {texts[i]!r}")

    # per-block soft constraints (blocks 9-40)
    um_blocks = []
    for b in range(len(texts) // BLOCK):
        blk = texts[b * BLOCK:(b + 1) * BLOCK]
        n_um = sum(t.count(ch) for t in blk for ch in UMLAUTS)
        um_blocks.append(n_um)
        if b * BLOCK < N_OLD:
            continue
        n_dig = sum(any(ch.isdigit() for ch in t) for t in blk)
        n_qe = sum(("?" in t or "!" in t) for t in blk)
        if n_um < 10:
            errs.append(f"block {b + 1}: only {n_um} umlaut/ß characters, need >= 10")
        if n_dig < 2:
            errs.append(f"block {b + 1}: only {n_dig} lines with digits, need >= 2")
        if n_qe < 2:
            errs.append(f"block {b + 1}: only {n_qe} questions/exclamations, need >= 2")

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
    c68 = counts(texts[100:N_OLD])
    need(c68, RARE, 2, "blocks6-8")
    for ch in RARE:
        if c100.get(ch, 0):
            errs.append(f"'{ch}' must not appear in the first 100 lines")

    # ---- report ----
    print(f"{path.name}: {len(prompts)} prompts, {n_en} english, lengths "
          f"{min(map(len, texts))}-{max(map(len, texts))}")
    for label, c, chars_ in (("blocks 1-2 (40 lines)", c12, None), ("first 100", c100, None),
                             (f"all {len(texts)}", call, None)):
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
    print("umlaut/ß characters per block: " + " ".join(f"{i + 1}:{n}" for i, n in enumerate(um_blocks)))
    print(f"  blocks 9-40: min {min(um_blocks[8:], default=0)}, lines with digits per block min "
          f"{min((sum(any(ch.isdigit() for ch in t) for t in texts[b * BLOCK:(b + 1) * BLOCK]) for b in range(N_OLD // BLOCK, len(texts) // BLOCK)), default=0)}, "
          f"?/! lines per block min "
          f"{min((sum(('?' in t or '!' in t) for t in texts[b * BLOCK:(b + 1) * BLOCK]) for b in range(N_OLD // BLOCK, len(texts) // BLOCK)), default=0)}")
    if errs:
        print(f"\nFAIL: {len(errs)} violation(s)")
        for e in errs:
            print("  - " + e)
        return 1
    print("\nOK: all rules satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main())

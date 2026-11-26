#!/usr/bin/env python3
"""Verify web/prompts/de-core.json (de-core@4) against docs/SPEC.md section 2.4 and
print coverage.

Rules
  format      set name, fields id/text/lang/block, block = (position - 1) // 20 + 1,
              ids de-core-0001 .. de-core-NNNN each exactly once.
  history     ids 0001-0800 keep text and lang of de-core@2: checked against the
              snapshot data/prompts/de-core@2.json, and the snapshot against the git
              commit that published de-core@2 (when git is available).  Every id of
              de-core@3 keeps its text and lang: checked against the snapshot
              data/prompts/de-core@3.json, and that against its git commit.
              Positions 1-160 are exactly those of de-core@2.  Ids from 0801 on are
              exactly the accepted lines of data/prompts/additions.txt.
  lines       18-40 characters, model alphabet only, no stray whitespace.
  duplicates  no two lines equal ignoring case and punctuation; no near-duplicates:
              pairs inside ids 0001-0800 with the de-core@2 rule (only pairs that
              involve ids 0161-0800), every pair that involves an addition with the
              de-core@3 rule (build_prompts.similar).
  variety     from position 161 on: no two neighbours of the same category or with
              the same first word; at most one digit-heavy line (3+ digits) among any
              four neighbours and at most four per block; at most six lines with a digit
              per block; at most two English lines per block; every full block has >= 2
              lines of <= 28 and >= 2 lines of >= 37 characters.
  focus       positions 161-220 reach every target of build_prompts.FOCUS, positions
              221-420 half that rate, and neither falls below what de-core@3 offered over
              the same number of open prompts (build_prompts.focus_minimums); the prompts
              in build_prompts.WRITTEN and the next build_prompts.NEXT_IN_LINE open
              prompts of de-core@3 are not in positions 161-420.
  coverage    from position 161 on: while Ä, Ö or Ü has been offered fewer than 30 times
              (counted from position 1 at the start of the block), the block contains it,
              and such blocks have >= 3 capital umlauts; never two blocks in a row
              without a capital umlaut; every rare character (Ä Ö Ü % € C E L N O Q V X Y)
              has been offered min(30, its total in the set) times by position 800.
  early lines the rules of de-core@1/@2 for blocks 1-2, the first 100 lines and
              blocks 6-8 (all inside the frozen positions 1-160).

Usage: python3 scripts/check_prompts.py [--reproduce] [path/to/de-core.json]
  --reproduce  also rebuild the set in memory and compare it byte for byte (slow).
Exit code 1 on any violation.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hw.charset import DEFAULT_CHARSET  # noqa: E402
import build_prompts as B  # noqa: E402

SNAPSHOT_COMMIT = "41764891cce494e7af75bd99bc7c0eeb0dff6b47"   # published de-core@2
SNAPSHOT3_COMMIT = "20b44f18ff02420068236d68c4ac39a26f295a1c"  # published de-core@3
BLOCK = B.BLOCK
N_OLD, N_FROZEN, N_V1 = B.N_OLD, B.N_FROZEN, 160
UMLAUTS = "äöüÄÖÜß"
LOWER = "abcdefghijklmnopqrstuvwxyzäöüß"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ"
DIGITS = "0123456789"
PUNCT = '.,!?:-()"\''
SIGNS = ";/%+=&@€"
RARE_SIGNS = "#*_[]"
RARE_CAPS = "QXY"
COVERAGE_BY = 800

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


def line(label, chars, c):
    return f"  {label:<8}" + " ".join(f"{ch}:{c.get(ch, 0)}" for ch in chars)


def compare_with_git(path, commit, name, errs):
    raw = path.read_text(encoding="utf-8")
    try:
        git = subprocess.run(["git", "-C", str(ROOT), "show", f"{commit}:web/prompts/de-core.json"],
                             capture_output=True, timeout=30)
        if git.returncode == 0:
            if git.stdout.decode("utf-8") != raw:
                errs.append(f"snapshot {path.name} differs from {name} in git ({commit[:7]})")
            else:
                print(f"snapshot matches {name} in git commit {commit[:7]}")
        else:
            print(f"note: git history not available, {path.name} not compared with git")
    except (OSError, subprocess.SubprocessError):
        print(f"note: git not available, {path.name} not compared with git")
    return raw


def check_history(prompts, errs):
    snap_raw = compare_with_git(B.SNAPSHOT_PATH, SNAPSHOT_COMMIT, "de-core@2", errs)
    compare_with_git(B.SNAPSHOT3_PATH, SNAPSHOT3_COMMIT, "de-core@3", errs)
    snap = json.loads(snap_raw)["prompts"]
    by_id = {p.get("id"): p for p in prompts}
    for sp in snap:
        p = by_id.get(sp["id"])
        if p is None:
            errs.append(f"{sp['id']} of de-core@2 is missing")
        elif (p.get("text"), p.get("lang")) != (sp["text"], sp["lang"]):
            errs.append(f"{sp['id']} changed: {sp['text']!r} -> {p.get('text')!r}")
    for pid, (text, lang) in B.load_snapshot3().items():
        p = by_id.get(pid)
        if p is None:
            errs.append(f"{pid} of de-core@3 is missing")
        elif (p.get("text"), p.get("lang")) != (text, lang):
            errs.append(f"{pid} changed against de-core@3: {text!r} -> {p.get('text')!r}")
    for i in range(min(N_FROZEN, len(prompts))):
        if prompts[i] != snap[i]:
            errs.append(f"position {i + 1}: must stay {snap[i]['id']} (got {prompts[i].get('id')})")
    accepted, _ = B.accept_additions([p["text"] for p in snap])
    for pid, text, lang, _ in accepted:
        p = by_id.get(pid)
        if p is None:
            errs.append(f"{pid} ({text!r}) from additions.txt is missing")
        elif (p.get("text"), p.get("lang")) != (text, lang):
            errs.append(f"{pid}: expected {text!r}/{lang}, got {p.get('text')!r}/{p.get('lang')}")
    return snap, {pid: cat for pid, _, _, cat in accepted}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = Path(args[0]) if args else B.JSON_PATH
    errs = []

    def need(c, chars, minimum, where, exceptions=None):
        for ch in chars:
            m = (exceptions or {}).get(ch, minimum)
            if c.get(ch, 0) < m:
                errs.append(f"{where}: '{ch}' occurs {c.get(ch, 0)}x, need >= {m}")

    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if data.get("set") != B.SET_NAME:
        errs.append(f"set must be {B.SET_NAME!r}, got {data.get('set')!r}")
    prompts = data.get("prompts", [])
    n = len(prompts)

    # ---- format
    seen_text, ids = set(), []
    for i, p in enumerate(prompts):
        if set(p) != {"id", "text", "lang", "block"}:
            errs.append(f"#{i + 1}: fields must be exactly id,text,lang,block (got {sorted(p)})")
        ids.append(p.get("id"))
        if p.get("block") != i // BLOCK + 1:
            errs.append(f"#{i + 1}: block {p.get('block')!r}, expected {i // BLOCK + 1}")
        if p.get("lang") not in ("de", "en"):
            errs.append(f"#{i + 1}: lang {p.get('lang')!r}")
        t = p.get("text", "")
        if not B.MIN_LEN <= len(t) <= B.MAX_LEN:
            errs.append(f"#{i + 1}: length {len(t)} outside {B.MIN_LEN}-{B.MAX_LEN}: {t!r}")
        bad = sorted({ch for ch in t if ch not in DEFAULT_CHARSET})
        if bad:
            errs.append(f"#{i + 1}: characters outside alphabet {bad}: {t!r}")
        if t != t.strip() or "  " in t:
            errs.append(f"#{i + 1}: stray whitespace: {t!r}")
        if t in seen_text:
            errs.append(f"#{i + 1}: duplicate text {t!r}")
        seen_text.add(t)
    if sorted(ids) != [f"de-core-{k:04d}" for k in range(1, n + 1)]:
        dup = [x for x, c in Counter(ids).items() if c > 1]
        errs.append(f"ids must be de-core-0001..{n:04d}, each once (duplicates: {dup[:5]})")
    if n % BLOCK:
        print(f"note: last block {n // BLOCK + 1} has {n % BLOCK} lines")

    # ---- history
    snap, new_cats = check_history(prompts, errs)
    texts = [p.get("text", "") for p in prompts]
    langs = [p.get("lang") for p in prompts]
    num = [int(p["id"][-4:]) if str(p.get("id", "")).startswith("de-core-") else 0 for p in prompts]
    cats = [new_cats.get(p.get("id")) or B.derived_category(p.get("text", "") or " ", p.get("lang")) for p in prompts]

    # ---- duplicates
    keys = [B.norm_key(t) for t in texts]
    byk = {}
    for i, k in enumerate(keys):
        byk.setdefault(k, []).append(i)
    for k, idx in byk.items():
        if len(idx) > 1 and max(num[i] for i in idx) > N_V1:
            errs.append("duplicate lines ignoring case/punctuation: " + ", ".join(f"#{i + 1}" for i in idx))
    wsets = [B.word_set(t) for t in texts]
    old_idx = [i for i in range(n) if num[i] <= N_OLD]
    new_idx = [i for i in range(n) if num[i] > N_OLD]
    for a in old_idx:
        for b in old_idx:
            if num[a] < num[b] and num[b] > N_V1 and keys[a] != keys[b] and B.near_duplicate(wsets[a], wsets[b]):
                errs.append(f"#{b + 1} is a near-duplicate of #{a + 1}: {texts[b]!r} / {texts[a]!r}")
    index, pos_of = B.SimIndex(), []
    for i in sorted(range(n), key=lambda i: num[i]):          # in id order
        if num[i] > N_OLD:
            for j in index.matches(texts[i]):
                a = pos_of[j]
                if keys[a] != keys[i]:
                    errs.append(f"#{i + 1} ({prompts[i]['id']}) nearly duplicates #{a + 1}: {texts[i]!r} / {texts[a]!r}")
        index.add(texts[i])
        pos_of.append(i)

    # ---- variety (after the frozen positions)
    fw = [B.first_word(t) for t in texts]
    dh = [B.is_digit_heavy(t) for t in texts]
    lc = [B.length_class(t) for t in texts]
    for i in range(N_FROZEN, n):
        if cats[i] == cats[i - 1]:
            errs.append(f"#{i}/#{i + 1}: two neighbours of category {cats[i]!r}: {texts[i - 1]!r} / {texts[i]!r}")
        if fw[i] == fw[i - 1]:
            errs.append(f"#{i}/#{i + 1}: both start with {fw[i]!r}")
        if dh[i] and any(dh[max(N_FROZEN, i - B.DIGIT_WINDOW + 1):i]):
            errs.append(f"#{i + 1}: digit-heavy line within {B.DIGIT_WINDOW} of another: {texts[i]!r}")
    blocks = range(N_FROZEN // BLOCK, (n + BLOCK - 1) // BLOCK)
    for b in blocks:
        sl = range(b * BLOCK, min(n, (b + 1) * BLOCK))
        if sum(dh[i] for i in sl) > B.MAX_DIGIT_BLOCK:
            errs.append(f"block {b + 1}: {sum(dh[i] for i in sl)} digit-heavy lines, max {B.MAX_DIGIT_BLOCK}")
        if sum(B.n_digits(texts[i]) > 0 for i in sl) > B.MAX_DIGIT_LINES:
            errs.append(f"block {b + 1}: {sum(B.n_digits(texts[i]) > 0 for i in sl)} lines with digits, max {B.MAX_DIGIT_LINES}")
        if sum(langs[i] == "en" for i in sl) > B.MAX_EN_BLOCK:
            errs.append(f"block {b + 1}: {sum(langs[i] == 'en' for i in sl)} English lines, max {B.MAX_EN_BLOCK}")
        if len(sl) == BLOCK:
            ns, nl = sum(lc[i] == "short" for i in sl), sum(lc[i] == "long" for i in sl)
            if ns < B.MIN_SHORT or nl < B.MIN_LONG:
                errs.append(f"block {b + 1}: {ns} short / {nl} long lines, need >= {B.MIN_SHORT} / {B.MIN_LONG}")
    # English in the frozen blocks (unchanged rule of de-core@2)
    for b in range(N_FROZEN // BLOCK):
        k = langs[b * BLOCK:(b + 1) * BLOCK].count("en")
        if not 1 <= k <= 4:
            errs.append(f"block {b + 1}: {k} english lines, expected 1-4")

    # ---- coverage of rare characters
    offered = Counter()
    for t in texts[:N_FROZEN]:
        for ch in B.RARE:
            offered[ch] += t.count(ch)
    prev_has = True
    for b in blocks:
        blk = texts[b * BLOCK:(b + 1) * BLOCK]
        c = Counter(ch for t in blk for ch in t if ch in B.RARE)
        caps = sum(c[ch] for ch in B.CAP_UMLAUTS)
        phase1 = [ch for ch in B.CAP_UMLAUTS if offered[ch] < B.GOAL]
        for ch in phase1:
            if not c[ch]:
                errs.append(f"block {b + 1}: no {ch} although only {offered[ch]} offered so far")
        if phase1 and caps < 3:
            errs.append(f"block {b + 1}: {caps} capital umlauts, need >= 3 while one has < {B.GOAL}")
        if not caps and not prev_has:
            errs.append(f"blocks {b}-{b + 1}: no capital umlaut in two blocks in a row")
        prev_has = caps > 0
        offered.update(c)
    total = Counter(ch for t in texts for ch in t if ch in B.RARE)
    early = Counter(ch for t in texts[:COVERAGE_BY] for ch in t if ch in B.RARE)
    for ch in B.RARE:
        want = min(B.GOAL, total[ch])
        if early[ch] < want:
            errs.append(f"'{ch}' offered {early[ch]}x in positions 1-{COVERAGE_BY}, need >= {want}")

    # ---- focus
    a0, a1, b1 = N_FROZEN, N_FROZEN + B.FOCUS_A, N_FROZEN + B.FOCUS_A + B.FOCUS_B
    for (lo, hi), minimum in zip(((a0, a1), (a1, b1)), B.focus_minimums()):
        c = B.focus_counts(texts[lo:hi])
        for k, m in minimum.items():
            if c[k] < m:
                errs.append(f"positions {lo + 1}-{hi}: focus unit {k!r} {c[k]}x, need >= {m}")
    for i in range(a0, min(n, b1)):
        if prompts[i].get("id") in B.WRITTEN:
            errs.append(f"#{i + 1}: {prompts[i]['id']} is already written, must not be in positions {a0 + 1}-{b1}")
    next_ids = {pid for pid, _ in B.prev_open()[:B.NEXT_IN_LINE]}
    for i in range(a0, min(n, b1)):
        if prompts[i].get("id") in next_ids:
            errs.append(f"#{i + 1}: {prompts[i]['id']} is next in line in de-core@3, must not be in positions {a0 + 1}-{b1}")

    # ---- early lines (frozen, rules of de-core@1/@2)
    b12, b100 = texts[:40], texts[:100]
    c12, c100 = counts(b12), counts(b100)
    need(c12, LOWER + UPPER, 2, "blocks1-2", {ch: 1 for ch in RARE_CAPS})
    need(c12, DIGITS, 3, "blocks1-2")
    need(c12, PUNCT, 2, "blocks1-2")
    need(c100, LOWER, 12, "first100")
    need(c100, UPPER, 3, "first100")
    need(c100, DIGITS, 10, "first100")
    need(c100, SIGNS, 3, "first100")
    pc100 = pair_counts(b100)
    for p in TOP_PAIRS:
        if pc100.get(p, 0) < 5:
            errs.append(f"first100: pair '{p}' occurs {pc100.get(p, 0)}x, need >= 5")
    low100 = [t.lower() for t in b100]
    for s in COMBOS:
        if sum(t.count(s) for t in low100) < 5:
            errs.append(f"first100: combination '{s}' occurs less than 5x")
    need(counts(texts[100:N_V1]), RARE_SIGNS, 2, "blocks6-8")
    for ch in RARE_SIGNS:
        if c100.get(ch, 0):
            errs.append(f"'{ch}' must not appear in the first 100 lines")

    if "--reproduce" in sys.argv:
        rebuilt = B.build()[0]
        if rebuilt != raw:
            errs.append("build_prompts.py does not reproduce the file from its inputs")
        else:
            print("reproduced byte for byte by build_prompts.py")

    # ---- report
    print(f"{path.name}: {n} prompts ({len(new_idx)} added after de-core@2), "
          f"{langs.count('en')} english, lengths {min(map(len, texts))}-{max(map(len, texts))}")
    print("categories from position 161: " + " ".join(f"{k}:{v}" for k, v in sorted(Counter(cats[N_FROZEN:]).items())))
    print(f"all {n}")
    call = counts(texts)
    print(line("lower", LOWER, call))
    print(line("upper", UPPER, call))
    print(line("digits", DIGITS, call))
    print(line("signs", PUNCT + SIGNS + RARE_SIGNS, call))
    snap_texts = [p["text"] for p in snap]
    print(f"rare characters, positions {B.N_FROZEN + 1}-{B.N_FROZEN + 200}:")
    for label, ts in (("de-core@2", snap_texts), (B.SET_NAME, texts)):
        c = Counter(ch for t in ts[B.N_FROZEN:B.N_FROZEN + 200] for ch in t if ch in B.RARE)
        print(f"  {label:<10}" + " ".join(f"{ch}:{c[ch]}" for ch in B.RARE))
    print("rare characters per 100 prompts:")
    B.print_rare_table(texts, 0, n)
    B.print_focus(texts)
    first30 = {}
    run = Counter()
    for i, t in enumerate(texts):
        for ch in B.RARE:
            run[ch] += t.count(ch)
            if ch not in first30 and run[ch] >= B.GOAL:
                first30[ch] = i + 1
    print("position where each is offered for the 30th time: "
          + " ".join(f"{ch}:{first30.get(ch, '-')}" for ch in B.RARE)
          + "   (total in set: " + " ".join(f"{ch}:{total[ch]}" for ch in B.RARE) + ")")
    um = [sum(t.count(ch) for t in texts[b * BLOCK:(b + 1) * BLOCK] for ch in UMLAUTS) for b in range((n + BLOCK - 1) // BLOCK)]
    first = B.N_FROZEN // BLOCK
    print("umlaut/ß characters per block after the frozen blocks: min %d, mean %.1f" % (min(um[first:]), sum(um[first:]) / len(um[first:])))
    if errs:
        print(f"\nFAIL: {len(errs)} violation(s)")
        for e in errs[:200]:
            print("  - " + e)
        return 1
    print("\nOK: all rules satisfied")
    return 0


if __name__ == "__main__":
    sys.exit(main())

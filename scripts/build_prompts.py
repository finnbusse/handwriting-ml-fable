#!/usr/bin/env python3
"""Grow web/prompts/de-core.json from the first 160 prompts to 800 (de-core@2).

Input : the first 160 prompts of web/prompts/de-core.json (kept byte-for-byte)
        and the candidate pool data/prompts/pool.txt (one line each, English
        lines prefixed with "en|").
Output: web/prompts/de-core.json with 800 prompts (blocks 1-40) and a report.

Selection is greedy and deterministic (no randomness, ties broken by pool
order).  Demand is measured over single characters and, inside words
(case-sensitive, with word-start "^" and word-end "$" markers), character
bigrams and trigrams:

  bigram  target 12   (25 if it contains ä ö ü Ä Ö Ü ß)
  trigram target  5   (25 if it contains ä ö ü Ä Ö Ü ß)
      -- only for n-grams that occur at least 3 times in the accepted pool
  capital letters A-Z Ä Ö Ü: 30 each      digits: 60 each
  punctuation . , ! ? : ; - ( ) " ' / % + = & @ €: 20 each
  lowercase ä ö ü ß: 80 each

The gain of a candidate is the sum over its units of (remaining need) /
(target) per occurrence, i.e. units lose value as they fill up (diminishing
returns).  New lines are picked block by block (blocks 9-40, 20 lines each)
under the soft constraints: >= 10 umlaut/ß characters, >= 2 lines with digits
and >= 2 questions/exclamations per block; every 12th new line is English.

Usage: python3 scripts/build_prompts.py [--dry-run]
"""
from __future__ import annotations

import heapq
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from hw.charset import DEFAULT_CHARSET  # noqa: E402

JSON_PATH = ROOT / "web" / "prompts" / "de-core.json"
POOL_PATH = ROOT / "data" / "prompts" / "pool.txt"

N_KEEP, N_TOTAL, BLOCK = 160, 800, 20
MIN_LEN, MAX_LEN = 18, 40
SET_NAME = "de-core@2"

UMLAUT_LOWER = "äöüß"
UMLAUT_ALL = "äöüÄÖÜß"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ"
DIGITS = "0123456789"
PUNCT = ".,!?:;-()\"'/%+=&@€"

T_BIGRAM, T_TRIGRAM, T_UMLAUT = 12, 5, 25
T_CAPITAL, T_DIGIT, T_PUNCT, T_UMLAUT_CHAR = 30, 60, 20, 80
MIN_POOL_OCC = 3
NEAR_DUP = 0.6          # shared-word fraction above which two lines are near-duplicates
EN_EVERY = 12           # one English line per 12 new lines
UM_ASSUME = 3           # umlaut/ß characters a later slot of the block can still add

_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]+")
_TOKEN = re.compile(r"[a-zäöüß0-9]+")


# ---------------------------------------------------------------- helpers
def norm_key(text: str) -> str:
    """Line identity ignoring case and punctuation/spacing."""
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def word_set(text: str) -> frozenset:
    return frozenset(_TOKEN.findall(text.casefold()))


def near_duplicate(a: frozenset, b: frozenset) -> bool:
    """True if the lines share more than 60 % of their words."""
    if not a or not b:
        return False
    return len(a & b) / max(len(a), len(b)) > NEAR_DUP


def unit_counts(text: str) -> Counter:
    """Single characters (no space), in-word bigrams and trigrams with markers."""
    c = Counter()
    for ch in text:
        if ch != " ":
            c[("c", ch)] += 1
    for w in _WORD.findall(text):
        p = "^" + w + "$"
        for i in range(len(p) - 1):
            c[("b", p[i:i + 2])] += 1
        for i in range(len(p) - 2):
            c[("t", p[i:i + 3])] += 1
    return c


def has_umlaut(s: str) -> bool:
    return any(ch in UMLAUT_ALL for ch in s)


def n_umlaut(text: str) -> int:
    return sum(text.count(ch) for ch in UMLAUT_ALL)


def entry_text(i: int, text: str, lang: str, block: int) -> str:
    return ('{\n"id": "de-core-%04d",\n"text": %s,\n"lang": "%s",\n"block": %d\n}'
            % (i, json.dumps(text, ensure_ascii=False), lang, block))


def render(entries) -> str:
    """entries: list of (text, lang) in order; block = (index // 20) + 1."""
    parts = [entry_text(i + 1, t, lang, i // BLOCK + 1) for i, (t, lang) in enumerate(entries)]
    return '{\n"set": "%s",\n"prompts": [\n' % SET_NAME + ",\n".join(parts) + "\n]\n}"


# ---------------------------------------------------------------- pool
def load_pool(existing_texts):
    """Returns (candidates, stats).  A candidate is (text, lang)."""
    stats = Counter()
    keys = {norm_key(t) for t in existing_texts}
    ex_words = [word_set(t) for t in existing_texts]
    out, seen = [], set()
    for raw in POOL_PATH.read_text(encoding="utf-8").split("\n"):
        if not raw.strip():
            continue
        stats["lines"] += 1
        lang, text = ("en", raw[3:]) if raw.startswith("en|") else ("de", raw)
        if text != text.strip() or "  " in text:
            stats["rejected: whitespace"] += 1
        elif any(ch not in DEFAULT_CHARSET for ch in text):
            stats["rejected: charset"] += 1
        elif not MIN_LEN <= len(text) <= MAX_LEN:
            stats["rejected: length"] += 1
        elif norm_key(text) in keys or norm_key(text) in seen:
            stats["rejected: duplicate"] += 1
        elif any(near_duplicate(word_set(text), w) for w in ex_words):
            stats["rejected: near-duplicate of first 160"] += 1
        else:
            seen.add(norm_key(text))
            out.append((text, lang))
    stats["accepted"] = len(out)
    return out, stats


# ---------------------------------------------------------------- demand
def make_targets(pool_units_total: Counter) -> dict:
    t = {}
    for ch in UPPER:
        t[("c", ch)] = T_CAPITAL
    for ch in DIGITS:
        t[("c", ch)] = T_DIGIT
    for ch in PUNCT:
        t[("c", ch)] = T_PUNCT
    for ch in UMLAUT_LOWER:
        t[("c", ch)] = T_UMLAUT_CHAR
    for u, n in pool_units_total.items():
        kind, s = u
        if kind == "c" or n < MIN_POOL_OCC:
            continue
        if has_umlaut(s):
            t[u] = T_UMLAUT
        else:
            t[u] = T_BIGRAM if kind == "b" else T_TRIGRAM
    return t


def coverage(targets: dict, have: Counter):
    met = sum(1 for u, tg in targets.items() if have.get(u, 0) >= tg)
    frac = sum(min(have.get(u, 0), tg) / tg for u, tg in targets.items()) / len(targets)
    return met, frac


# ---------------------------------------------------------------- main
def main() -> int:
    dry = "--dry-run" in sys.argv
    raw = JSON_PATH.read_text(encoding="utf-8")
    data = json.loads(raw)
    keep = data["prompts"][:N_KEEP]
    assert len(keep) == N_KEEP
    keep_pairs = [(p["text"], p["lang"]) for p in keep]
    keep_texts = [t for t, _ in keep_pairs]
    prefix = render(keep_pairs)[:-len("\n]\n}")]          # header + 160 entries
    # prompts 1-160 must be reproduced exactly (apart from the "set" header line)
    old_body = raw.split("\n", 2)[2]
    assert prefix.split("\n", 2)[2] == old_body[:len(prefix.split("\n", 2)[2])], \
        "first 160 entries are not reproduced byte-identically"

    pool, pstats = load_pool(keep_texts)
    n_new = N_TOTAL - N_KEEP

    # --- units
    pool_units = [unit_counts(t) for t, _ in pool]
    pool_total = Counter()
    for u in pool_units:
        pool_total.update(u)
    targets = make_targets(pool_total)
    uid = {u: i for i, u in enumerate(sorted(targets))}
    inv_t = [0.0] * len(uid)
    for u, i in uid.items():
        inv_t[i] = 1.0 / targets[u]
    have = Counter()
    for t in keep_texts:
        have.update(unit_counts(t))
    rem = [0] * len(uid)
    for u, i in uid.items():
        rem[i] = max(0, targets[u] - have.get(u, 0))
    cand_units = [[(uid[u], n) for u, n in cu.items() if u in uid] for cu in pool_units]
    before_met, before_frac = coverage(targets, have)

    def gain(k: int) -> float:
        g = 0.0
        for i, n in cand_units[k]:
            r = rem[i]
            if r:
                c = n if n < r else r
                g += inv_t[i] * (c * r - c * (c - 1) / 2)
        return g

    # --- candidate attributes
    texts = [t for t, _ in pool]
    is_en = [lang == "en" for _, lang in pool]
    words = [word_set(t) for t in texts]
    um = [n_umlaut(t) for t in texts]
    dig = [any(ch.isdigit() for ch in t) for t in texts]
    qe = [("?" in t or "!" in t) for t in texts]
    by_word = {}
    for k, ws in enumerate(words):
        for w in ws:
            by_word.setdefault(w, []).append(k)
    dead = [False] * len(pool)
    n_conflict = 0

    def kill_conflicts(k: int):
        nonlocal n_conflict
        seen = set()
        for w in words[k]:
            for j in by_word[w]:
                if j != k and not dead[j] and j not in seen:
                    seen.add(j)
                    if near_duplicate(words[k], words[j]):
                        dead[j] = True
                        n_conflict += 1

    # lines of the first 160 also exclude near-duplicates (already done in load_pool)
    heap = [(-gain(k), k) for k in range(len(pool))]
    heapq.heapify(heap)
    chosen = []

    def pick(allowed) -> int | None:
        aside, found = [], None
        while heap:
            g, k = heapq.heappop(heap)
            if dead[k]:
                continue
            if not allowed(k):
                aside.append((g, k))
                continue
            ng = -gain(k)
            if heap and ng > heap[0][0]:           # someone else may be better now
                heapq.heappush(heap, (ng, k))
                continue
            found = k
            break
        for item in aside:
            heapq.heappush(heap, item)
        return found

    for blk in range(N_KEEP // BLOCK + 1, N_TOTAL // BLOCK + 1):
        b_um = b_dig = b_qe = 0
        for slot in range(BLOCK):
            i = len(chosen)
            want_en = (i % EN_EVERY == EN_EVERY - 1)
            r = BLOCK - slot
            need_um = max(0, 10 - b_um)
            need_dig = max(0, 2 - b_dig)
            need_qe = max(0, 2 - b_qe)

            def make(use_qe, use_dig, use_um):
                def allowed(k):
                    if is_en[k] != want_en:
                        return False
                    if use_dig and need_dig and need_dig >= r - 1 and not dig[k]:
                        return False
                    if use_qe and need_qe and need_qe >= r - 2 and not qe[k]:
                        return False
                    if use_um and um[k] < need_um - (r - 1) * UM_ASSUME:
                        return False
                    return True
                return allowed

            k = None
            for flags in ((1, 1, 1), (0, 1, 1), (1, 0, 1), (0, 0, 1), (0, 0, 0)):
                k = pick(make(*flags))
                if k is not None:
                    break
            if k is None:
                print("error: pool exhausted", file=sys.stderr)
                return 2
            chosen.append(k)
            b_um += um[k]
            b_dig += dig[k]
            b_qe += qe[k]
            kill_conflicts(k)
            for i2, n in cand_units[k]:
                rem[i2] = max(0, rem[i2] - n)
            dead[k] = True

    new_entries = [(texts[k], "en" if is_en[k] else "de") for k in chosen]
    out = prefix + ",\n" + ",\n".join(
        entry_text(N_KEEP + i + 1, t, lang, (N_KEEP + i) // BLOCK + 1)
        for i, (t, lang) in enumerate(new_entries)) + "\n]\n}"
    assert out.split("\n", 2)[2].startswith(old_body[:len(prefix.split("\n", 2)[2])])
    if not dry:
        JSON_PATH.write_text(out, encoding="utf-8")

    # ------------------------------------------------------------ report
    all_texts = keep_texts + [t for t, _ in new_entries]
    all_langs = [l for _, l in keep_pairs] + [l for _, l in new_entries]
    final = Counter()
    for t in all_texts:
        final.update(unit_counts(t))
    after_met, after_frac = coverage(targets, final)
    print(f"pool: {pstats['lines']} lines read, {pstats['accepted']} accepted, "
          f"{pstats['lines'] - pstats['accepted']} rejected")
    for k_, v in sorted(pstats.items()):
        if k_.startswith("rejected"):
            print(f"  {k_}: {v}")
    print(f"  dropped as near-duplicate of a chosen line: {n_conflict}")
    print(f"  chosen: {len(chosen)}  (English: {sum(is_en[k] for k in chosen)})")
    print(f"written {JSON_PATH.relative_to(ROOT)}: {len(all_texts)} prompts, set {SET_NAME}"
          + (" (dry run, not written)" if dry else ""))

    nb = sum(1 for u in targets if u[0] == "b")
    nt = sum(1 for u in targets if u[0] == "t")
    nc = sum(1 for u in targets if u[0] == "c")
    print(f"\ndemanded units: {len(targets)} ({nc} characters, {nb} bigrams, {nt} trigrams)")
    print(f"  before (160 prompts): {before_met} units at target, mean fill {before_frac:.1%}")
    print(f"  after  (800 prompts): {after_met} units at target, mean fill {after_frac:.1%}")
    for label, kind in (("characters", "c"), ("bigrams", "b"), ("trigrams", "t")):
        us = [u for u in targets if u[0] == kind]
        b = sum(min(have.get(u, 0), targets[u]) / targets[u] for u in us) / len(us)
        a = sum(min(final.get(u, 0), targets[u]) / targets[u] for u in us) / len(us)
        print(f"  {label:<11} mean fill {b:.1%} -> {a:.1%}")

    print("\n30 worst-covered demanded units (count/target, pool occurrences):")
    worst = sorted(targets, key=lambda u: (final.get(u, 0) / targets[u], -(targets[u] - final.get(u, 0)), u))[:30]
    print("  " + "  ".join(f"{u[1]!r}[{u[0]}]:{final.get(u, 0)}/{targets[u]}({pool_total.get(u, 0)})" for u in worst))

    c = Counter("".join(all_texts))
    print("\nper-character totals (all 800 lines):")
    for label, chars in (("lower", "abcdefghijklmnopqrstuvwxyzäöüß"), ("upper", UPPER), ("digits", DIGITS),
                         ("punct", PUNCT + " ")):
        print(f"  {label:<7}" + " ".join(f"{ch}:{c.get(ch, 0)}" for ch in chars))

    print("\numlaut/ß characters per block (ä ö ü Ä Ö Ü ß):")
    per = [sum(n_umlaut(t) for t in all_texts[b * BLOCK:(b + 1) * BLOCK]) for b in range(N_TOTAL // BLOCK)]
    print("  " + " ".join(f"{b + 1}:{n}" for b, n in enumerate(per)))
    print(f"  total {sum(per)}, per character: " + " ".join(f"{ch}:{c.get(ch, 0)}" for ch in UMLAUT_ALL)
          + f"; min block {min(per[8:])} (blocks 9-40)")
    lens = [len(t) for t in all_texts]
    print(f"line length min/mean/max (new lines): "
          f"{min(map(len, [t for t, _ in new_entries]))}/"
          f"{sum(len(t) for t, _ in new_entries) / len(new_entries):.1f}/"
          f"{max(map(len, [t for t, _ in new_entries]))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

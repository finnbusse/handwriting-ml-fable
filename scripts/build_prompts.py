#!/usr/bin/env python3
"""Build web/prompts/de-core.json as prompt set de-core@3.

Inputs (all in data/prompts/):
  de-core@2.json  snapshot of the 800 prompts of de-core@2 (ids de-core-0001..0800).
                  Ids and texts never change; positions 1-240 (blocks 1-12) are
                  copied byte-for-byte, because the writer may reach them before
                  de-core@3 is live.
  additions.txt   new lines, grouped under "## <category>" headers, in a fixed
                  order.  Accepted lines get ids de-core-0801, 0802, ... in file
                  order; a line that duplicates or nearly duplicates an existing
                  prompt (or an earlier accepted addition) is dropped.
  pool.txt        the candidate pool de-core@2 was drawn from (history only; not
                  read here).

Everything from position 241 on (prompts 241-800 of de-core@2 and all accepted
additions) is put into a new order, slot by slot, deterministically (no
randomness, ties broken by input order).  Blocks are renumbered by position
(block = (position - 1) // 20 + 1); the app reads the block from the file.

Each slot takes the best-scoring line that passes the variety rules:
  hard   never two neighbours of the same category; never two neighbours that
         start with the same word; at most one digit-heavy line (3+ digits)
         among any four neighbours and at most four per block; at most two
         English lines per block.
  block  every full block has >= 2 short lines (<= 28 characters) and >= 2 long
         lines (>= 37 characters).  While Ä, Ö or Ü has been offered fewer than
         30 times (counted from position 1, at the start of the block) the block
         contains it and has >= 3 capital umlauts; after that no two blocks in a
         row are without a capital umlaut.  A block requirement forces the
         choice only when the remaining slots of the block are just enough.
  score  (1) coverage: the greedy n-gram gain of de-core@2 (bigrams/trigrams in
         words, rare single characters) with diminishing returns, measured
         against positions 1-240;
         (2) a schedule for the rarest characters RARE: each has a target count
         that rises by RATE per block until it reaches GOAL (or the supply runs
         out) and then grows steadily, so the rest of the supply is spread over
         the remaining positions; a line earns a bonus for every scheduled
         character that is behind its target (and a small penalty for scarce
         characters that are ahead of it in the steady phase);
         (3) pacing: every category, English, digit-heavy, short and long lines
         and lines with ä ö ü ß are pulled towards an even spread over the whole
         range, so the end of the set stays as varied as the beginning.
  If no line passes, the rules are relaxed one at a time (block requirement,
  first word, category, digit/English limits) and the report says how often.

Categories of de-core@2 prompts (derived): "englisch" (lang en), "zahlen"
(3+ digits), "rede" (contains a double quote), "liste" (no final . ! ?),
"satz" (everything else).  Additions carry their own category.

Usage: python3 scripts/build_prompts.py [--dry-run]
"""
from __future__ import annotations

import difflib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from hw.charset import DEFAULT_CHARSET  # noqa: E402

JSON_PATH = ROOT / "web" / "prompts" / "de-core.json"
DATA = ROOT / "data" / "prompts"
SNAPSHOT_PATH = DATA / "de-core@2.json"
ADDITIONS_PATH = DATA / "additions.txt"
POOL_PATH = DATA / "pool.txt"

SET_NAME = "de-core@3"
N_OLD = 800             # prompts of de-core@2, ids 0001-0800
N_FROZEN = 240          # positions 1-240 stay exactly where they are
BLOCK = 20
MIN_LEN, MAX_LEN = 18, 40

# ---- rare characters: schedule
RARE = "ÄÖÜ%€CELNOQVXY"
CAP_UMLAUTS = "ÄÖÜ"
GOAL = 30               # offered this often (from position 1) before the steady phase
RATE = {ch: 2 for ch in RARE}   # target increase per block in phase 1
ABUNDANT = "ELNV"       # no penalty for being ahead of schedule
MIN_CAPS_PHASE1 = 3    # capital umlauts per block while one of Ä Ö Ü is in phase 1
STEADY_SLACK = 60      # steady phase planned over this many slots more than there are

# ---- variety
SHORT_MAX, LONG_MIN = 28, 37
MIN_SHORT, MIN_LONG = 2, 2
DIGIT_HEAVY = 3         # digits in a line that make it digit-heavy
DIGIT_WINDOW = 4        # at most one digit-heavy line among this many neighbours
MAX_DIGIT_BLOCK = 4
MAX_EN_BLOCK = 2

# ---- n-gram demand (as in de-core@2)
UMLAUT_LOWER = "äöüß"
UMLAUT_ALL = "äöüÄÖÜß"
UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ"
DIGITS = "0123456789"
PUNCT = ".,!?:;-()\"'/%+=&@€"
T_BIGRAM, T_TRIGRAM, T_UMLAUT = 12, 5, 25
T_CAPITAL, T_DIGIT, T_PUNCT, T_UMLAUT_CHAR = 30, 60, 20, 80
MIN_POOL_OCC = 3
CHAR_WEIGHT = 40
UMLAUT_CHAR_WEIGHT = 3

# ---- score weights
W_GAIN = 1.0            # coverage gain, normalised to the 90th percentile at the start
W_RARE = 1.2            # per scheduled character behind target
W_AHEAD = 0.4           # per scarce character far ahead of target (steady phase)
W_PACE = 0.35           # per line of deficit against an even spread

# ---- duplicates
NEAR_DUP = 0.6          # de-core@2 rule: shared-word fraction above which lines are near-duplicates
SIM_WORDS = 0.75        # de-core@3 rule: word-set Jaccard ...
SIM_CHARS = 0.82        # ... or character similarity of the normalised texts

_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]+")
_TOKEN = re.compile(r"[a-zäöüß0-9]+")


# ---------------------------------------------------------------- helpers
def norm_key(text: str) -> str:
    """Line identity ignoring case and punctuation/spacing."""
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def norm_spaced(text: str) -> str:
    """Casefolded text with punctuation turned into single spaces."""
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text.casefold()).split())


def word_set(text: str) -> frozenset:
    return frozenset(_TOKEN.findall(text.casefold()))


def near_duplicate(a: frozenset, b: frozenset) -> bool:
    """de-core@2 rule (kept for pairs inside the first 800): > 60 % shared words."""
    if not a or not b:
        return False
    return len(a & b) / max(len(a), len(b)) > NEAR_DUP


def similar(a: str, b: str) -> bool:
    """de-core@3 rule for pairs that involve an addition: same text ignoring case and
    punctuation, the same words in another order or nearly so (Jaccard >= 0.75), or
    nearly the same characters (difflib ratio >= 0.82 on the normalised texts)."""
    if norm_key(a) == norm_key(b):
        return True
    wa, wb = word_set(a), word_set(b)
    if wa and wb and len(wa & wb) / len(wa | wb) >= SIM_WORDS:
        return True
    sm = difflib.SequenceMatcher(None, norm_spaced(a), norm_spaced(b), autojunk=False)
    return (sm.real_quick_ratio() >= SIM_CHARS and sm.quick_ratio() >= SIM_CHARS
            and sm.ratio() >= SIM_CHARS)


def _sim_keys(text: str) -> set:
    toks = set(_TOKEN.findall(text.casefold()))
    long_ = {t for t in toks if len(t) >= 4}
    return (long_ or toks) | {"#" + norm_key(text)}


class SimIndex:
    """Finds earlier lines that are `similar` to a text.  Only lines that share a word
    of four or more letters (or any word, for lines without one) are compared; two
    lines of 18+ characters that pass `similar` always share such a word in practice."""

    def __init__(self):
        self.texts, self.by_key = [], {}

    def add(self, text: str) -> int:
        i = len(self.texts)
        self.texts.append(text)
        for k in _sim_keys(text):
            self.by_key.setdefault(k, []).append(i)
        return i

    def matches(self, text: str):
        cand = set()
        for k in _sim_keys(text):
            cand.update(self.by_key.get(k, ()))
        return [i for i in sorted(cand) if similar(text, self.texts[i])]


def first_word(text: str) -> str:
    m = _TOKEN.search(text.casefold())
    return m.group(0) if m else ""


def n_digits(text: str) -> int:
    return sum(ch.isdigit() for ch in text)


def is_digit_heavy(text: str) -> bool:
    return n_digits(text) >= DIGIT_HEAVY


def derived_category(text: str, lang: str) -> str:
    if lang == "en":
        return "englisch"
    if is_digit_heavy(text):
        return "zahlen"
    if '"' in text:
        return "rede"
    if text[-1] not in ".!?":
        return "liste"
    return "satz"


def length_class(text: str) -> str:
    n = len(text)
    return "short" if n <= SHORT_MAX else "long" if n >= LONG_MIN else "mid"


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


def entry_text(pid: str, text: str, lang: str, block: int) -> str:
    return ('{\n"id": "%s",\n"text": %s,\n"lang": "%s",\n"block": %d\n}'
            % (pid, json.dumps(text, ensure_ascii=False), lang, block))


def render(entries) -> str:
    """entries: list of (id, text, lang) in order; block = (index // 20) + 1."""
    parts = [entry_text(pid, t, lang, i // BLOCK + 1) for i, (pid, t, lang) in enumerate(entries)]
    return '{\n"set": "%s",\n"prompts": [\n' % SET_NAME + ",\n".join(parts) + "\n]\n}"


# ---------------------------------------------------------------- inputs
def load_snapshot():
    data = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    old = data["prompts"]
    assert data["set"] == "de-core@2" and len(old) == N_OLD, "snapshot must hold the 800 prompts of de-core@2"
    for i, p in enumerate(old):
        assert p["id"] == f"de-core-{i + 1:04d}", p["id"]
    return old


def read_additions():
    """Returns [(text, category)] in file order."""
    out, cat = [], None
    for raw in ADDITIONS_PATH.read_text(encoding="utf-8").split("\n"):
        if not raw:
            continue
        if raw.startswith("## "):
            cat = raw[3:].strip()
            continue
        if cat is None:
            raise ValueError("additions.txt: line before the first '## category' header")
        out.append((raw, cat))
    return out


def accept_additions(old_texts):
    """Returns (accepted [(id, text, lang, cat)], dropped [(text, reason)])."""
    accepted, dropped = [], []
    compare = SimIndex()
    for t in old_texts:
        compare.add(t)
    for text, cat in read_additions():
        if text != text.strip() or "  " in text:
            dropped.append((text, "whitespace"))
        elif any(ch not in DEFAULT_CHARSET for ch in text):
            dropped.append((text, "charset"))
        elif not MIN_LEN <= len(text) <= MAX_LEN:
            dropped.append((text, "length"))
        else:
            hits = compare.matches(text)
            if hits:
                dropped.append((text, f"near-duplicate of {compare.texts[hits[0]]!r}"))
                continue
            pid = f"de-core-{N_OLD + len(accepted) + 1:04d}"
            accepted.append((pid, text, "en" if cat == "englisch" else "de", cat))
            compare.add(text)
    return accepted, dropped


def categories():
    """{id: category} for every prompt of de-core@3 (used by check_prompts.py)."""
    old = load_snapshot()
    accepted, _ = accept_additions([p["text"] for p in old])
    cats = {p["id"]: derived_category(p["text"], p["lang"]) for p in old}
    cats.update({pid: cat for pid, _, _, cat in accepted})
    return cats


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
        t[u] = T_UMLAUT if has_umlaut(s) else (T_BIGRAM if kind == "b" else T_TRIGRAM)
    for ch in RARE:                      # scheduled separately
        t.pop(("c", ch), None)
    return t


class Schedule:
    """Target count over the region for one rare character."""

    def __init__(self, ch, have, supply, n_slots):
        self.ch, self.have0, self.supply, self.n = ch, have, supply, n_slots
        self.t1 = min(GOAL, have + supply)
        need = max(0, self.t1 - have)
        self.p1 = min(n_slots, math.ceil(need / RATE[ch]) * BLOCK) if need else 0
        self.rest = supply - need

    def target(self, s: int) -> float:
        """Target count (from position 1) once slot s (0-based) is filled."""
        if s < self.p1:
            return min(self.t1, self.have0 + RATE[self.ch] * (s + 1) / BLOCK)
        span = max(1, self.n - self.p1 + STEADY_SLACK)  # a little slower, so the supply lasts to the end
        return self.t1 + self.rest * (s + 1 - self.p1) / span

    def steady(self, s: int) -> bool:
        return s >= self.p1


# ---------------------------------------------------------------- ordering
def order_region(region, frozen_texts):
    """region: [(id, text, lang, cat)] in input order.  Returns (ordered list, stats)."""
    n = len(region)
    texts = [r[1] for r in region]
    langs = [r[2] for r in region]
    cats = [r[3] for r in region]
    fws = [first_word(t) for t in texts]
    dheavy = [is_digit_heavy(t) for t in texts]
    is_en = [lg == "en" for lg in langs]
    lclass = [length_class(t) for t in texts]
    capum = [any(ch in t for ch in CAP_UMLAUTS) for t in texts]
    rare_n = [{ch: t.count(ch) for ch in RARE if ch in t} for t in texts]

    # --- coverage gain (incremental)
    units = [unit_counts(t) for t in texts]
    total = Counter()
    for u in units:
        total.update(u)
    targets = make_targets(total)
    uid = {u: i for i, u in enumerate(sorted(targets))}
    inv_t = [0.0] * len(uid)
    for u, i in uid.items():
        w = 1.0
        if u[0] == "c":
            w = UMLAUT_CHAR_WEIGHT if u[1] in UMLAUT_LOWER else CHAR_WEIGHT
        inv_t[i] = w / targets[u]
    have_units = Counter()
    for t in frozen_texts:
        have_units.update(unit_counts(t))
    rem = [0] * len(uid)
    for u, i in uid.items():
        rem[i] = max(0, targets[u] - have_units.get(u, 0))
    cand_units = [[(uid[u], c) for u, c in cu.items() if u in uid] for cu in units]
    by_unit = [[] for _ in uid]
    for k, cu in enumerate(cand_units):
        for i, c in cu:
            by_unit[i].append((k, c))

    def contrib(i, c, r):
        if not r:
            return 0.0
        c = c if c < r else r
        return inv_t[i] * (c * r - c * (c - 1) / 2)

    gain = [sum(contrib(i, c, rem[i]) for i, c in cu) for cu in cand_units]
    g_sorted = sorted(gain)
    g_norm = g_sorted[int(0.9 * (n - 1))] or 1.0

    # --- rare schedules (offered = count from position 1)
    have_rare = Counter()
    for t in frozen_texts:
        for ch in RARE:
            have_rare[ch] += t.count(ch)
    supply = Counter()
    for rn in rare_n:
        supply.update(rn)
    sched = {ch: Schedule(ch, have_rare[ch], supply[ch], n) for ch in RARE}
    supply_left = Counter(supply)

    # --- pacing groups
    groups = []                                  # (name, members flags list)
    for c in sorted(set(cats)):
        groups.append(("cat:" + c, [x == c for x in cats]))
    groups.append(("en", is_en))
    groups.append(("digit", dheavy))
    groups.append(("short", [x == "short" for x in lclass]))
    groups.append(("long", [x == "long" for x in lclass]))
    groups.append(("umlaut", [any(ch in t for ch in UMLAUT_ALL) for t in texts]))
    g_total = [sum(m) for _, m in groups]
    g_placed = [0] * len(groups)
    member_of = [[gi for gi, (_, m) in enumerate(groups) if m[k]] for k in range(n)]

    alive = [True] * n
    order = []
    relaxed = Counter()
    blk_en = blk_dig = blk_short = blk_long = 0
    blk_rare = Counter()

    for s in range(n):
        slot_in_block = (N_FROZEN + s) % BLOCK
        if slot_in_block == 0:
            prev_block_capum = s == 0 or any(blk_rare[ch] for ch in CAP_UMLAUTS)
            # phase 1 for a capital umlaut: offered fewer than GOAL times when the block starts
            phase1_block = [ch for ch in CAP_UMLAUTS if have_rare[ch] < GOAL and supply_left[ch]]
            blk_en = blk_dig = blk_short = blk_long = 0
            blk_rare = Counter()
        block_len = min(BLOCK, n - (s - slot_in_block))
        left = block_len - slot_in_block          # slots left in this block incl. this one
        prev = order[-1] if order else None
        recent = order[-(DIGIT_WINDOW - 1):]

        # outstanding block requirements: list of predicates
        needs = []
        if block_len == BLOCK:
            needs += [lambda k: lclass[k] == "short"] * max(0, MIN_SHORT - blk_short)
            needs += [lambda k: lclass[k] == "long"] * max(0, MIN_LONG - blk_long)
        caps_in_block = sum(blk_rare[ch] for ch in CAP_UMLAUTS)
        missing = [ch for ch in phase1_block if not blk_rare[ch]]
        for ch in missing:
            needs.append(lambda k, ch=ch: ch in rare_n[k])
        if phase1_block:
            needs += [lambda k: capum[k]] * max(0, MIN_CAPS_PHASE1 - caps_in_block - len(missing))
        elif not prev_block_capum and not caps_in_block:
            needs.append(lambda k: capum[k])
        force = len(needs) >= left

        def ok(k, level):
            if level < 5 and dheavy[k] and (blk_dig >= MAX_DIGIT_BLOCK or any(dheavy[j] for j in recent)):
                return False
            if level < 5 and is_en[k] and blk_en >= MAX_EN_BLOCK:
                return False
            if prev is not None:
                if level < 4 and cats[k] == cats[prev]:
                    return False
                if level < 3 and fws[k] == fws[prev]:
                    return False
            if level < 1 and force and not any(f(k) for f in needs):
                return False
            return True

        def score(k):
            sc = W_GAIN * gain[k] / g_norm
            for ch, c in rare_n[k].items():
                sch = sched[ch]
                d = sch.target(s) - have_rare[ch]
                steady = sch.steady(s) and ch not in ABUNDANT
                lead = 0.0 if steady else 1.0        # phase 1 also rewards lines that are just on time
                if d + lead > 0:
                    sc += W_RARE * min(c, 2) * min(d + lead, 3)
                elif steady:
                    sc -= W_AHEAD * min(-d, 3)
            for gi in member_of[k]:
                d = g_total[gi] * (s + 1) / n - g_placed[gi]
                sc += W_PACE * max(-3.0, min(3.0, d))
            return sc

        best = None
        for level in range(6):
            bs = None
            for k in range(n):
                if alive[k] and ok(k, level):
                    v = score(k)
                    if bs is None or v > bs:
                        bs, best = v, k
            if best is not None:
                if level:
                    relaxed[level] += 1
                break
        k = best
        order.append(k)
        alive[k] = False
        blk_en += is_en[k]
        blk_dig += dheavy[k]
        blk_short += lclass[k] == "short"
        blk_long += lclass[k] == "long"
        for ch, c in rare_n[k].items():
            have_rare[ch] += c
            supply_left[ch] -= c
            blk_rare[ch] += c
        for gi in member_of[k]:
            g_placed[gi] += 1
        for i, c in cand_units[k]:
            r = rem[i]
            if not r:
                continue
            r2 = max(0, r - c)
            for j, cj in by_unit[i]:
                if alive[j]:
                    gain[j] += contrib(i, cj, r2) - contrib(i, cj, r)
            rem[i] = r2
    return [region[k] for k in order], {"relaxed": relaxed, "schedules": sched}


# ---------------------------------------------------------------- reporting
def rare_table(texts, start, stop, step=100):
    rows = []
    for a in range(start, stop, step):
        chunk = texts[a:min(a + step, stop)]
        c = Counter()
        for t in chunk:
            for ch in RARE:
                c[ch] += t.count(ch)
        rows.append((a + 1, min(a + step, stop), c))
    return rows


def print_rare_table(texts, start, stop, step=100):
    print("  positions   " + " ".join(f"{ch:>3}" for ch in RARE))
    for a, b, c in rare_table(texts, start, stop, step):
        print(f"  {a:>4}-{b:<5}  " + " ".join(f"{c[ch]:>3}" for ch in RARE))


# ---------------------------------------------------------------- main
def main() -> int:
    dry = "--dry-run" in sys.argv
    old = load_snapshot()
    old_texts = [p["text"] for p in old]
    accepted, dropped = accept_additions(old_texts)

    frozen = [(p["id"], p["text"], p["lang"]) for p in old[:N_FROZEN]]
    region = [(p["id"], p["text"], p["lang"], derived_category(p["text"], p["lang"])) for p in old[N_FROZEN:]]
    region += accepted
    ordered, st = order_region(region, [t for _, t, _ in frozen])
    entries = frozen + [(pid, t, lang) for pid, t, lang, _ in ordered]
    out = render(entries)

    # the first 240 entries must be byte-identical to de-core@2 (apart from the header line)
    snap_body = SNAPSHOT_PATH.read_text(encoding="utf-8").split("\n", 3)[3]
    out_body = out.split("\n", 3)[3]
    head = ",\n".join(entry_text(pid, t, lang, i // BLOCK + 1) for i, (pid, t, lang) in enumerate(frozen))
    assert snap_body.startswith(head) and out_body.startswith(head), "positions 1-240 are not reproduced"
    if not dry:
        JSON_PATH.write_text(out, encoding="utf-8")

    texts = [t for _, t, _ in entries]
    print(f"additions: {len(accepted) + len(dropped)} read, {len(accepted)} accepted "
          f"(ids de-core-{N_OLD + 1:04d}..de-core-{N_OLD + len(accepted):04d}), {len(dropped)} dropped")
    for t, why in dropped:
        print(f"  dropped {t!r}: {why}")
    print(f"written {JSON_PATH.relative_to(ROOT)}: {len(texts)} prompts, "
          f"{math.ceil(len(texts) / BLOCK)} blocks, set {SET_NAME}" + (" (dry run, not written)" if dry else ""))
    print("variety rules relaxed (by level): " + (", ".join(f"{k}:{v}" for k, v in sorted(st["relaxed"].items())) or "never"))
    print("rare-character schedules (offered from position 1; phase 1 ends at position):")
    for ch, sc in st["schedules"].items():
        print(f"  {ch}: had {sc.have0} in 1-240, supply {sc.supply}, goal {sc.t1} by position {N_FROZEN + sc.p1}")
    print("rare characters per 100 prompts:")
    print_rare_table(texts, 0, len(texts))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Build web/prompts/de-core.json as prompt set de-core@5.

de-core@5 is de-core@4 with two streams woven in after the frozen positions 1-160:
  eszett.txt  ordinary sentences with ß (the recordings held 29 ß in all), ids
              de-core-2808 .. 2880 in file order (ESZETT_IDS);
  rows.txt    3-6 unrelated words or numbers per line (9 rows with 3), ids
              de-core-2881 .. 3252 in file order (ROW_IDS).  They replace about
              1,400 older single-word recordings in an older, untidier hand
              (training cuts a row into its words); the first rows pack the
              scarcest characters densely.  Against the order the list was
              delivered in: the first 15 rows (positions 161-220) are picked so
              that those 60 prompts keep the focus minimums (NEXT_LINES,
              NEXT_SHORT); two number rows sit two and three rows later, so that
              no block has more than MAX_DIGIT_LINES lines with digits; and eight
              rows with a capital umlaut (delivered as rows 19, 20, 22, 23, 89, 104,
              110, 111; the first four with three each) changed places with plain
              rows and sit in blocks 34-70, where the thinned-out main sequence
              left two blocks in a row without a capital umlaut.
Ids and texts of de-core@5 are published: a stream line is never moved, changed or
removed.  A new line goes at the end of its file and takes the next free id after
the highest one in the set (de-core-3253 on), as a further range of that stream's
constant; so ESZETT_IDS and ROW_IDS are lists of ranges, and so is "streams".
In every block after the frozen ones, slots ROW_SLOTS hold the next rows and
ESZETT_SLOTS the next ß sentences while each stream lasts; every other slot (and a
stream's slots once it is used up) holds the next prompt of de-core@4 from position
161 on, in its order.  Removing the stream entries gives de-core@4 back exactly: the
de-core@4 order below is rebuilt and compared byte for byte with the snapshot
data/prompts/de-core@4.json.  Stream lines are checked for whitespace, alphabet,
length and exact duplicates; ß sentences also for near-duplicates of every other
sentence.  The rest of this text describes how de-core@4 was ordered.

Inputs of de-core@4 (all in data/prompts/):
  de-core@2.json  snapshot of the 800 prompts of de-core@2 (ids de-core-0001..0800).
                  Ids and texts never change; positions 1-160 (blocks 1-8) are
                  copied byte-for-byte, because the writer had written them all.
  de-core@3.json  snapshot of de-core@3 (2,491 prompts) as published: every id in
                  it must keep its text and language (checked, not read for the order).
  additions.txt   new lines, grouped under "## <category>" headers.  Accepted lines
                  get ids de-core-0801, 0802, ... in file order; a line that
                  duplicates or nearly duplicates an existing prompt (or an earlier
                  accepted addition) is dropped.  New lines only ever go at the end
                  of the file (a header may repeat), so the ids given stay.
  pool.txt        the candidate pool de-core@2 was drawn from (history only; not
                  read here).

Everything from position 161 on (prompts 161-800 of de-core@2 and all accepted
additions) is put into a new order, slot by slot, deterministically (no
randomness, ties broken by input order).  The prompts in WRITTEN (done by the
writer beyond position 160) are kept out of the focus phases, so the next blocks
the writer gets are all new to them; so are the next NEXT_IN_LINE open prompts of
de-core@3, in case the writer goes on in it before de-core@4 is published.  Blocks
are renumbered by position (block = (position - 1) // 20 + 1); the app reads the
block from the file.

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
  focus  positions 161-220 must be rich in what the trained model gets wrong
         (FOCUS: Ä Ö Ü T at a word start, the 'über' family, Q X Y C J j, ä ü,
         every digit, the scarce symbols), positions 221-420 at half that rate, and
         neither below what de-core@3 offered over the same number of open prompts;
         a line earns a bonus for every focus unit that is behind its target and
         a larger one for units still missing near the end of a phase; nouns
         used in the last 60 lines and lines with few letters lose points.
         The schedules of (2) for the focus characters rest during these phases.
         At most six lines with a digit per block.
  score  (1) coverage: the greedy n-gram gain of de-core@2 (bigrams/trigrams in
         words, rare single characters) with diminishing returns, measured
         against positions 1-160;
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
SNAPSHOT3_PATH = DATA / "de-core@3.json"
ADDITIONS_PATH = DATA / "additions.txt"
POOL_PATH = DATA / "pool.txt"
SNAPSHOT4_PATH = DATA / "de-core@4.json"
ESZETT_PATH = DATA / "eszett.txt"
ROWS_PATH = DATA / "rows.txt"

SET_NAME = "de-core@5"
MAIN_SET = "de-core@4"
N_MAIN = 2807           # prompts of de-core@4, the main sequence
# id ranges (first, last id number) of each stream; its lines take them in file order
ESZETT_IDS = ((2808, 2880),)   # ß sentences
ROW_IDS = ((2881, 3252),)      # word rows
ROW_SLOTS = (3, 7, 11, 15, 19)   # slots (1-20) of a block for rows: a quarter of the block,
ESZETT_SLOTS = (5, 13)           # ß sentences in between, never two stream lines side by side
# lines the writer's next 60 prompts (positions 161-220) hold at least, besides the phase-A focus
# minimums of de-core@4 (FOCUS): Ä Ö Ü at a word start and Q X Y C J as there, ß in a quarter
NEXT_LINES = {"ß": 15, "Ä-": 10, "Ö-": 10, "Ü-": 10, "Q": 6, "X": 6, "Y": 6, "C": 6, "J": 6}
# what those 60 prompts reach where they stay below a minimum: 21 of the 60 slots go to the
# streams, rows carry no signs and only two rows a capital X (both among the first 15).  A floor,
# so that a change can only make them better
NEXT_SHORT = {"X": 5, "#": 2, "%": 0, "&": 2, "'": 2, "*": 2, "/": 1, "@": 1, "€": 2}
N_OLD = 800             # prompts of de-core@2, ids 0001-0800
N_FROZEN = 160          # positions 1-160 stay exactly where they are (all written); progress is
                        # tracked by id, so anything later may move
N_PREV = 2491           # prompts of de-core@3
# written by the writer beyond position 160 when de-core@4 was built (de-core@3 positions
# 168, 183, 196, 545): not placed in the focus phases, where they would be skipped at once,
# but right after them: the capture screen shows block dots up to the last block with a
# written line, so one of these at the end of the set would push the current block out of view
WRITTEN = ("de-core-0161", "de-core-0162", "de-core-0163", "de-core-0164")
# the writer may write on in de-core@3 until de-core@4 is published.  The next NEXT_IN_LINE open
# prompts of de-core@3 are treated like WRITTEN, so up to that many such lines cannot thin out
# the focus phases, and the written ones still sit right after them
NEXT_IN_LINE = 20
W_WRITTEN = 20.0        # outscores every other line: the 24 held lines land in 421-461, right after the focus
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
COVER_BY = 800          # each rare character offered min(GOAL, its total) times by this position

# ---- focus: where the model trained on the first 164 lines (+ ~1,500 single words) fails.
# In that data: Ä 5, Ö 4, Ü 8, Q 5, X 4, Y 3, C 10, J 17; the symbols below 2-9 each.
# In generated writing the dots are missing on Ä in 96 % of cases, Ü 71 %, Ö 31 %, ä and ü
# 41 %, j 24 %; 'über' words garbled in 4 of 11, T written like V in 4 of 11, a wrong digit
# in 7 of 28 pieces with digits.  Targets for positions 161-220 (FOCUS_A slots); positions
# 221-420 (FOCUS_B slots) get half that rate.
FOCUS_A, FOCUS_B = 60, 200
FOCUS_STEP_B = 50       # phase B is checked in four parts, so it stays even
FOCUS_AIM_B = 1.2       # phase B aims 20 % above its minimum: the variety rules cost up to 3
                        # units of a symbol or digit over its 200 slots
FOCUS_LINES = {"Ä-": 10, "Ö-": 10, "Ü-": 10, "T-": 10, "über": 8,   # lines with the unit
               "Q": 6, "X": 6, "Y": 6, "C": 6, "J": 6, "j": 8, "ä": 20, "ü": 20}
FOCUS_CHARS = dict({d: 5 for d in "0123456789"},                   # occurrences
                   **{ch: 3 for ch in "\"#%&'()*+-/;=@[]_€"})
FOCUS = dict(FOCUS_LINES, **FOCUS_CHARS)
FOCUS_RARE = "ÄÖÜ%€CQXY"   # their schedules rest while the focus phases run
W_FOCUS_LINE = 1.5      # per focus line unit behind target
W_FOCUS_CHAR = 1.3      # per focus character behind target (there are 28 of them)
W_REPEAT = 2.5         # per noun (or noun stem) already used in the last REPEAT_WINDOW lines
REPEAT_WINDOW = 60
FOCUS_CHAR_MAX = 5      # focus characters rewarded per line: a phone number must not win by itself
MIN_LETTERS = 0.45      # in the focus phases, lines with fewer letters (phone numbers, sums) ...
W_DENSE = 3.0           # ... lose this much: they are no practice in writing words
W_URGENT = 30.0         # per unit still missing for the end of the phase, divided by the slots left

# ---- variety
SHORT_MAX, LONG_MIN = 28, 37
MIN_SHORT, MIN_LONG = 2, 2
DIGIT_HEAVY = 3         # digits in a line that make it digit-heavy
DIGIT_WINDOW = 4        # at most one digit-heavy line among this many neighbours
MAX_DIGIT_BLOCK = 4
MAX_DIGIT_LINES = 6     # lines with any digit per block (a third at most)
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


_WORD_START = {ch: re.compile(r"(?<![A-Za-zÄÖÜäöüß])" + ch) for ch in "ÄÖÜT"}


def focus_units(text: str) -> dict:
    """{FOCUS key: count} for one line: 1 for the line units, occurrences for the characters."""
    u = {ch + "-": 1 for ch, rx in _WORD_START.items() if rx.search(text)}
    if "über" in text.casefold():
        u["über"] = 1
    u.update({ch: 1 for ch in "QXYCJjäü" if ch in text})
    u.update({ch: text.count(ch) for ch in FOCUS_CHARS if ch in text})
    return u


def focus_minimums():
    """({unit: minimum over the FOCUS_A slots}, {unit: minimum over the FOCUS_B slots}).  Phase A
    gets FOCUS.  Phase B gets half that rate, but never less than de-core@3 offered the writer over
    the same open prompts (its next 61st-260th), nor so little that phases A and B together fall
    below de-core@3's next 260: no focus unit gets rarer than in the order it replaces.  Phase A
    is not held to de-core@3 as well: its 18 lines with digits cannot carry de-core@3's digits,
    % and € besides the 28 focus characters of FOCUS (at best 4 units stayed short)."""
    nxt = [t for _, t in prev_open()]
    fb = focus_counts(nxt[FOCUS_A:FOCUS_A + FOCUS_B])
    fab = focus_counts(nxt[:FOCUS_A + FOCUS_B])
    return (dict(FOCUS), {k: max(math.ceil(v * FOCUS_B / FOCUS_A / 2), fb[k], fab[k] - v)
                          for k, v in FOCUS.items()})


def focus_target(key: str, s: int, mins):
    """Target count over the region (from position 161) once slot s is filled; None after the focus."""
    a = mins[0][key]
    if s < FOCUS_A:
        return a * (s + 1) / FOCUS_A
    if s < FOCUS_A + FOCUS_B:
        return a + FOCUS_AIM_B * mins[1][key] * (s + 1 - FOCUS_A) / FOCUS_B
    return None


def focus_phase_end(s: int):
    """(slot where the focus phase of slot s ends, slots left in it incl. s), or None after the focus."""
    if s >= FOCUS_A + FOCUS_B:
        return None
    end = FOCUS_A if s < FOCUS_A else FOCUS_A + FOCUS_STEP_B * ((s - FOCUS_A) // FOCUS_STEP_B + 1)
    return end, end - s


_CAPWORD = re.compile(r"[A-ZÄÖÜ][a-zäöüß]{3,}")
_NOT_NOUNS = {"eine", "einen", "mein", "meine", "dein", "deine", "heute", "bitte", "wenn", "dann",
              "noch", "auch", "hast", "habe", "kannst", "wann", "dass", "sind", "gibt", "viele"}
# word families with many lines in the pool but no common five-letter stem (Öl, Ölbild, Ölpest,
# Ölsardinen ...; Äpfel, Äpfeln): without a key of their own 4 Öl- lines met in 161-220, with it 2
FAMILIES = ("öl", "äpfel")


def noun_keys(text: str) -> set:
    """Capitalised words (nouns, names, sentence starts), the first five letters of long ones and
    FAMILIES: so that 'Äpfel' or 'Übermorgen' does not come back line after line."""
    ws = [w for w in map(str.casefold, _CAPWORD.findall(text)) if w not in _NOT_NOUNS]
    fam = {f for w in _WORD.findall(text.casefold()) for f in FAMILIES if w.startswith(f)}
    return set(ws) | {w[:5] for w in ws if len(w) >= 6} | fam


def focus_counts(texts) -> Counter:
    c = Counter()
    for t in texts:
        c.update(focus_units(t))
    return c


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


def stream_ranges() -> dict:
    """The "streams" field of the file: {name: [[first id, last id], ...]}."""
    return {name: [[f"de-core-{a:04d}", f"de-core-{b:04d}"] for a, b in ranges]
            for name, ranges in (("eszett", ESZETT_IDS), ("rows", ROW_IDS))}


def stream_ids(ranges) -> list:
    return [f"de-core-{n:04d}" for a, b in ranges for n in range(a, b + 1)]


def render(entries, set_name=SET_NAME, streams=True) -> str:
    """entries: list of (id, text, lang) in order; block = (index // 20) + 1."""
    parts = [entry_text(pid, t, lang, i // BLOCK + 1) for i, (pid, t, lang) in enumerate(entries)]
    head = '{\n"set": "%s",\n' % set_name
    if streams:
        head += '"streams": %s,\n' % json.dumps(stream_ranges())
    return head + '"prompts": [\n' + ",\n".join(parts) + "\n]\n}"


def body(text: str) -> str:
    """The file text from the first prompt on (without the header fields)."""
    return text.split('"prompts": [\n', 1)[1]


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


def load_snapshot3():
    """{id: (text, lang)} of de-core@3 as published."""
    data = json.loads(SNAPSHOT3_PATH.read_text(encoding="utf-8"))
    assert data["set"] == "de-core@3" and len(data["prompts"]) == N_PREV, "snapshot must hold de-core@3"
    return {p["id"]: (p["text"], p["lang"]) for p in data["prompts"]}


def prev_open():
    """[(id, text)] of de-core@3 from position 161 on without WRITTEN: what the writer gets next there."""
    data = json.loads(SNAPSHOT3_PATH.read_text(encoding="utf-8"))
    return [(p["id"], p["text"]) for p in data["prompts"][N_FROZEN:] if p["id"] not in WRITTEN]


def read_lines(path):
    return [t for t in path.read_text(encoding="utf-8").split("\n") if t]


def row_category(text: str) -> str:
    return "zahlen" if is_digit_heavy(text) else "wörter"


def read_streams(main_texts):
    """Returns (eszett [(id, text, lang, cat)], rows [...]).  Raises on a line that breaks a
    rule: ids are given in file order, so a bad line is fixed in the file, never skipped."""
    seen = set(main_texts)
    compare = SimIndex()
    for t in main_texts:
        compare.add(t)
    out = {}
    for name, path, ranges in (("eszett", ESZETT_PATH, ESZETT_IDS), ("rows", ROWS_PATH, ROW_IDS)):
        out[name], ids = [], stream_ids(ranges)
        for text in read_lines(path):
            where = f"{path.name}: {text!r}"
            if text != text.strip() or "  " in text:
                raise ValueError(f"{where}: stray whitespace")
            if any(ch not in DEFAULT_CHARSET for ch in text):
                raise ValueError(f"{where}: character outside the model alphabet")
            if not MIN_LEN <= len(text) <= MAX_LEN:
                raise ValueError(f"{where}: length {len(text)} outside {MIN_LEN}-{MAX_LEN}")
            if text in seen:
                raise ValueError(f"{where}: duplicate")
            seen.add(text)
            if name == "eszett":
                hits = compare.matches(text)
                if hits:
                    raise ValueError(f"{where}: near-duplicate of {compare.texts[hits[0]]!r}")
                compare.add(text)
                cat = derived_category(text, "de")
            else:
                cat = row_category(text)
            if len(out[name]) == len(ids):
                raise ValueError(f"{where}: no id left in the ranges of {name}")
            out[name].append((ids[len(out[name])], text, "de", cat))
        if len(out[name]) != len(ids):
            raise ValueError(f"{path.name}: {len(out[name])} lines for {len(ids)} ids")
    return out["eszett"], out["rows"]


def weave(main, eszett, rows, start=N_FROZEN):
    """main, eszett, rows: lists of entries; main starts at position start + 1.  Returns the
    woven list from position start + 1 on (see the module text)."""
    streams = [(ROW_SLOTS, list(rows)), (ESZETT_SLOTS, list(eszett))]
    main = list(main)
    out = []
    while main or any(s for _, s in streams):
        slot = (start + len(out)) % BLOCK + 1
        src = next((s for slots, s in streams if slot in slots and s), None)
        if src is None:
            src = main or next(s for _, s in streams if s)
        out.append(src.pop(0))
    return out


def categories():
    """{id: category} for every prompt of the set (used by check_prompts.py)."""
    old = load_snapshot()
    accepted, _ = accept_additions([p["text"] for p in old])
    cats = {p["id"]: derived_category(p["text"], p["lang"]) for p in old}
    cats.update({pid: cat for pid, _, _, cat in accepted})
    main = json.loads(SNAPSHOT4_PATH.read_text(encoding="utf-8"))["prompts"]
    for s in read_streams([p["text"] for p in main]):
        cats.update({pid: cat for pid, _, _, cat in s})
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
    """Target count over the region for one rare character, from region slot `start` on."""

    def __init__(self, ch, have, supply, n_slots, start=0, rate=None):
        self.ch, self.have0, self.supply, self.n, self.start = ch, have, supply, n_slots, start
        self.rate = rate or RATE[ch]
        self.t1 = min(GOAL, have + supply)
        need = max(0, self.t1 - have)
        self.p1 = min(n_slots, math.ceil(need / self.rate) * BLOCK) if need else 0
        self.rest = supply - need

    def target(self, s: int) -> float:
        """Target count (from position 1) once slot s (0-based) is filled."""
        s -= self.start
        if s < self.p1:
            return min(self.t1, self.have0 + self.rate * (s + 1) / BLOCK)
        span = max(1, self.n - self.p1 + STEADY_SLACK)  # a little slower, so the supply lasts to the end
        return self.t1 + self.rest * (s + 1 - self.p1) / span

    def steady(self, s: int) -> bool:
        return s - self.start >= self.p1


# ---------------------------------------------------------------- ordering
def order_region(region, frozen_texts, before=None):
    """region: [(id, text, lang, cat)] in input order.  Returns (ordered list, stats).
    `before` = (category, first word) of the last frozen prompt, the first region prompt's neighbour."""
    n = len(region)
    texts = [r[1] for r in region]
    next_ids = {pid for pid, _ in prev_open()[:NEXT_IN_LINE]}
    held = [r[0] in WRITTEN or r[0] in next_ids for r in region]
    mins = focus_minimums()
    fu = [focus_units(t) for t in texts]
    have_focus = Counter()
    has_digit = [n_digits(t) > 0 for t in texts]
    nouns = [noun_keys(t) for t in texts]
    dense = [sum(ch.isalpha() for ch in t) < MIN_LETTERS * len(t.replace(" ", "")) for t in texts]
    recent_nouns = Counter()
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
    pace0, placed0 = 0, [0] * len(groups)      # pacing restarts after the focus phases
    member_of = [[gi for gi, (_, m) in enumerate(groups) if m[k]] for k in range(n)]

    alive = [True] * n
    order = []
    relaxed = Counter()
    blk_en = blk_dig = blk_short = blk_long = blk_dline = 0
    blk_rare = Counter()

    for s in range(n):
        if s == FOCUS_A + FOCUS_B:
            # the focus took many umlaut, digit and sign lines early: spread the rest evenly from
            # here, or the next blocks would make up for it with none at all
            pace0, placed0 = s, list(g_placed)
            # the focus characters went at their own pace: plan the rest from where they stand,
            # reaching GOAL evenly by position COVER_BY (check_prompts.py requires it)
            left = max(BLOCK, COVER_BY - N_FROZEN - s)
            for ch in FOCUS_RARE:
                need = max(0, min(GOAL, have_rare[ch] + supply_left[ch]) - have_rare[ch])
                sched[ch] = Schedule(ch, have_rare[ch], supply_left[ch], n - s, start=s,
                                     rate=max(RATE[ch] / 4, need * BLOCK / left))
        slot_in_block = (N_FROZEN + s) % BLOCK
        if slot_in_block == 0:
            prev_block_capum = s == 0 or any(blk_rare[ch] for ch in CAP_UMLAUTS)
            # phase 1 for a capital umlaut: offered fewer than GOAL times when the block starts
            phase1_block = [ch for ch in CAP_UMLAUTS if have_rare[ch] < GOAL and supply_left[ch]]
            blk_en = blk_dig = blk_short = blk_long = blk_dline = 0
            blk_rare = Counter()
        in_focus = s < FOCUS_A + FOCUS_B
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
            if level < 5 and has_digit[k] and blk_dline >= MAX_DIGIT_LINES:
                return False
            if prev is None and before is not None:
                if level < 4 and cats[k] == before[0]:
                    return False
                if level < 3 and fws[k] == before[1]:
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
            sc = W_GAIN * gain[k] / g_norm + W_WRITTEN * held[k]
            if in_focus:
                end, left_ph = focus_phase_end(s)
                chars = []
                for key, c in fu[k].items():
                    v = 0.0
                    d = focus_target(key, s, mins) - have_focus[key]
                    if d + 1 > 0:                    # +1: also rewards lines that are just on time
                        v += min(c, 2) * min(d + 1, 3)
                    short = math.ceil(focus_target(key, end - 1, mins) - 1e-9) - have_focus[key]
                    if short > 0:
                        v += W_URGENT * min(c, short) * short / left_ph
                    if key in FOCUS_LINES:
                        sc += W_FOCUS_LINE * v
                    else:
                        chars.append(v)
                sc += W_FOCUS_CHAR * sum(sorted(chars, reverse=True)[:FOCUS_CHAR_MAX])
                sc -= W_REPEAT * sum(recent_nouns[w] for w in nouns[k]) + W_DENSE * dense[k]
            for ch, c in rare_n[k].items():
                if in_focus and ch in FOCUS_RARE:
                    continue
                sch = sched[ch]
                d = sch.target(s) - have_rare[ch]
                steady = sch.steady(s) and ch not in ABUNDANT
                lead = 0.0 if steady else 1.0        # phase 1 also rewards lines that are just on time
                if d + lead > 0:
                    sc += W_RARE * min(c, 2) * min(d + lead, 3)
                elif steady:
                    sc -= W_AHEAD * min(-d, 3)
            for gi in member_of[k]:
                d = (g_total[gi] - placed0[gi]) * (s + 1 - pace0) / (n - pace0) - (g_placed[gi] - placed0[gi])
                sc += W_PACE * max(-3.0, min(3.0, d))
            return sc

        best = None
        for level in range(6):
            bs = None
            for k in range(n):
                if alive[k] and not (in_focus and held[k]) and ok(k, level):
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
        blk_dline += has_digit[k]
        have_focus.update(fu[k])
        recent_nouns.update(nouns[k])
        if len(order) > REPEAT_WINDOW:
            recent_nouns.subtract(nouns[order[-REPEAT_WINDOW - 1]])
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
def build():
    """Returns (file text, entries [(id, text, lang)], accepted, dropped, stats); stats also
    holds "main" (the de-core@4 entries) and "eszett", "rows" (the stream entries)."""
    old = load_snapshot()
    accepted, dropped = accept_additions([p["text"] for p in old])
    frozen = [(p["id"], p["text"], p["lang"]) for p in old[:N_FROZEN]]
    region = [(p["id"], p["text"], p["lang"], derived_category(p["text"], p["lang"])) for p in old[N_FROZEN:]]
    region += accepted
    last = frozen[-1]
    ordered, st = order_region(region, [t for _, t, _ in frozen],
                               before=(derived_category(last[1], last[2]), first_word(last[1])))
    main = frozen + [(pid, t, lang) for pid, t, lang, _ in ordered]
    assert len(main) == N_MAIN, f"de-core@4 order has {len(main)} prompts, expected {N_MAIN}"
    assert render(main, MAIN_SET, streams=False) == SNAPSHOT4_PATH.read_text(encoding="utf-8"), \
        "the de-core@4 order is not reproduced (data/prompts/de-core@4.json)"
    eszett, rows = read_streams([t for _, t, _ in main])
    strip = lambda es: [e[:3] for e in es]  # noqa: E731
    entries = frozen + weave(main[N_FROZEN:], strip(eszett), strip(rows))
    st.update(main=main, eszett=eszett, rows=rows)
    return render(entries), entries, accepted, dropped, st


def print_focus(texts):
    a, b = N_FROZEN + FOCUS_A, N_FROZEN + FOCUS_A + FOCUS_B
    ma, mb = focus_minimums()
    rows = [(N_FROZEN, a, ma), (a, b, mb)]
    print("focus units (lines for " + " ".join(FOCUS_LINES) + "; occurrences for the rest), count/minimum:")
    for lo, hi, minimum in rows:
        c = focus_counts(texts[lo:hi])
        dl = sum(n_digits(t) > 0 for t in texts[lo:hi])
        print(f"  {lo + 1}-{hi}: " + " ".join(f"{k}:{c[k]}/{minimum[k]}" for k in FOCUS)
              + f"  lines with digits: {dl} of {hi - lo}")


def next_counts(texts) -> Counter:
    """focus_counts plus lines with ß."""
    c = focus_counts(texts)
    c["ß"] = sum("ß" in t for t in texts)
    return c


def next_targets() -> dict:
    """{unit: minimum} over the writer's next FOCUS_A prompts of de-core@5 (positions 161-220):
    the phase-A minimums of de-core@4 and NEXT_LINES."""
    return dict(focus_minimums()[0], **NEXT_LINES)


def print_next(texts):
    c, m = next_counts(texts[N_FROZEN:N_FROZEN + FOCUS_A]), next_targets()
    print(f"  {N_FROZEN + 1}-{N_FROZEN + FOCUS_A}: " + " ".join(f"{k}:{c[k]}/{v}" for k, v in m.items()))


def main() -> int:
    dry = "--dry-run" in sys.argv
    out, entries, accepted, dropped, st = build()
    frozen = entries[:N_FROZEN]
    prev = load_snapshot3()
    for pid, t, lang in entries:
        assert pid not in prev or prev[pid] == (t, lang), f"{pid} changed against de-core@3"
    assert set(prev) <= {pid for pid, _, _ in entries}, "a prompt of de-core@3 is missing"

    # the first 160 entries must be byte-identical to de-core@2 (apart from the header lines)
    snap_body = body(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    head = ",\n".join(entry_text(pid, t, lang, i // BLOCK + 1) for i, (pid, t, lang) in enumerate(frozen))
    assert snap_body.startswith(head) and body(out).startswith(head), "positions 1-160 are not reproduced"
    stream_ids = {e[0] for e in st["eszett"] + st["rows"]}
    assert [e for e in entries if e[0] not in stream_ids] == st["main"], "the main sequence is disturbed"
    if not dry:
        JSON_PATH.write_text(out, encoding="utf-8")

    texts = [t for _, t, _ in entries]
    print(f"additions: {len(accepted) + len(dropped)} read, {len(accepted)} accepted "
          f"(ids de-core-{N_OLD + 1:04d}..de-core-{N_OLD + len(accepted):04d}), {len(dropped)} dropped")
    for t, why in dropped:
        print(f"  dropped {t!r}: {why}")
    print(f"de-core@4 order reproduced ({N_MAIN} prompts); streams: {len(st['eszett'])} ß sentences "
          f"{st['eszett'][0][0]}..{st['eszett'][-1][0]}, {len(st['rows'])} word rows "
          f"{st['rows'][0][0]}..{st['rows'][-1][0]}")
    pos = {pid: i + 1 for i, (pid, _, _) in enumerate(entries)}
    print(f"  ß sentences at positions {pos[st['eszett'][0][0]]}-{pos[st['eszett'][-1][0]]}, "
          f"rows at {pos[st['rows'][0][0]]}-{pos[st['rows'][-1][0]]}")
    print(f"written {JSON_PATH.relative_to(ROOT)}: {len(texts)} prompts, "
          f"{math.ceil(len(texts) / BLOCK)} blocks, set {SET_NAME}" + (" (dry run, not written)" if dry else ""))
    print("de-core@4 order: variety rules relaxed (by level): "
          + (", ".join(f"{k}:{v}" for k, v in sorted(st["relaxed"].items())) or "never"))
    print("rare characters per 100 prompts:")
    print_rare_table(texts, 0, len(texts))
    print("de-core@4 order (the main sequence):")
    print_focus([t for _, t, _ in st["main"]])
    print(f"{SET_NAME}, the writer's next {FOCUS_A} prompts:")
    print_next(texts)
    return 0


if __name__ == "__main__":
    sys.exit(main())

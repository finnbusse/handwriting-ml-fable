"""Build the training set from raw recordings.

    raw recordings --prepare()--> inks in xh units, resampled
                   --LineComposer--> word groups laid out as lines
                   --to_model()--> offset sequences in model units
"""
from __future__ import annotations

import collections
import json
import zlib

import numpy as np

from . import prep, sources
from .ink import Ink, to_offsets

MAX_POINTS = 700          # the base model was trained on sequences cut at 700 points


# ----------------------------------------------------------------- preparation
def load_exclusions(path: str = "data/quality/exclude.json") -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"sources": {}, "ids": {}}


def apply_exclusions(inks: list[Ink], excl: dict) -> tuple[list[Ink], dict]:
    bad_src, bad_ids = set(excl.get("sources", {})), set(excl.get("ids", {}))
    kept = [i for i in inks if i.source not in bad_src and i.id not in bad_ids]
    counts = collections.Counter("source" if i.source in bad_src else "audit"
                                 for i in inks if i.source in bad_src or i.id in bad_ids)
    return kept, dict(counts)


DIGIT_RATIO = 0.8        # digits are about as tall as capitals: 0.8 x the ascender height
SESSION_MIN_LINES = 8         # a capture session needs this many lines to have a letter size of its own
WORD_XH_POWER = 0.3           # how far a single word may move away from its source's typical letter size
RARE_CHAR_COUNT = 8           # a line or word with a character rarer than this is never held out
LINE_SIZE_POWER = 0.5         # line_size "blend": how much of its own deviation from the session a line keeps
LINE_SIZE_CLAMP = 0.15        # ... and never more than this far from the session median
MAX_HEIGHT_WORD = 9.0         # x-heights; taller recordings are measured wrongly or scribbles
MAX_HEIGHT_LINE = 12.0        # a line adds baseline drift and tall brackets
PREP_VERSION = 8         # bump when the preparation changes (invalidates the cache)


def measure(raw: list[Ink], line_size: str = "session") -> tuple[list[Ink], dict]:
    """Clean every recording, find its baseline and x-height and bring it into
    xh units (baseline y=0, x-height 1, left edge x=0).  Not yet resampled.

    `line_size` decides the x-height of a line of a session that is large
    enough: "session" gives every line the session median; "blend" keeps part
    of the line's own deviation (LINE_SIZE_POWER, clamped to LINE_SIZE_CLAMP)."""
    # prep.clean hands back the caller's point array when there is nothing to
    # drop and the steps below change it in place; the copy keeps a second call
    # on the same recordings from starting with altered ink (step_xh 0.1571
    # instead of 0.1556)
    inks = [c for c in (prep.clean(i.copy()) for i in raw) if c is not None]

    # 1. baselines and letter heights
    geo = {}
    for ink in inks:
        a, b, _ = prep.baseline(ink)
        geo[ink.id] = (a, b, prep.letter_heights(ink, a, b))

    # 2. the writer's ratio (height of tall letters) / (x-height); only needed
    #    for inks without small letters such as digit strings
    ratios = []
    for ink in inks:
        a, b, h = geo[ink.id]
        small, tall = prep.text_classes(ink.text)
        if not (small and tall) or len(h) < 4:
            continue
        xh = prep.fit_xheight(h, ink.text, 2.4)
        hi = h[h > 1.6 * xh] if np.isfinite(xh) else []
        if len(hi):
            ratios.append(float(np.median(hi)) / xh)
    tall_ratio = float(np.median(ratios)) if ratios else 2.4

    # 3. per-ink x-height -> xh units.  The estimate from one line or word is
    #    noisy: it depends on which letters happen to be in it (measured on 120
    #    capture lines: a third of them land more than 15 % off).  People do not
    #    change their letter size from one line to the next, so
    #      - every line of a recording session gets the session's median; small
    #        sessions borrow the median of all lines of the same source;
    #      - a single word keeps only a small part of its own deviation from the
    #        typical size of its source.
    sizes = {}
    for ink in inks:
        a, b, h = geo[ink.id]
        ratio = tall_ratio * (DIGIT_RATIO if ink.text.replace(" ", "").isdigit() else 1.0)
        sizes[ink.id] = prep.fit_xheight(h, ink.text, ratio)
    ok = lambda v: bool(np.isfinite(v) and v > 0)
    by_session, by_source = collections.defaultdict(list), collections.defaultdict(list)
    for ink in inks:
        if ok(sizes[ink.id]):
            by_source[(ink.source, ink.kind)].append(sizes[ink.id])
            if ink.kind == "line":
                by_session[(ink.source, ink.meta.get("session") or "")].append(sizes[ink.id])
    resized = 0
    for ink in inks:
        own = sizes[ink.id]
        source = by_source.get((ink.source, ink.kind), [])
        if ink.kind == "line":
            group = by_session.get((ink.source, ink.meta.get("session") or ""), [])
            if len(group) < SESSION_MIN_LINES:
                group = source
            if len(group) >= SESSION_MIN_LINES:
                med = float(np.median(group))
                if line_size == "blend" and ok(own):
                    sizes[ink.id] = float(np.clip(med * (own / med) ** LINE_SIZE_POWER,
                                                  med * (1 - LINE_SIZE_CLAMP), med * (1 + LINE_SIZE_CLAMP)))
                else:
                    sizes[ink.id] = med
                resized += 1
        elif len(source) >= 30:
            med = float(np.median(source))
            sizes[ink.id] = med * (own / med) ** WORD_XH_POWER if ok(own) else med

    out, dropped = [], collections.Counter()
    for ink in inks:
        a, b, h = geo[ink.id]
        xh = sizes[ink.id]
        if not np.isfinite(xh) or xh <= 0:
            dropped["no-size"] += 1
            continue
        n = prep.to_xh_units(ink, a, b, xh)
        n.meta["xh_px"] = xh
        n.meta["slope"] = a
        if n.kind == "line" and not has_final_period(n):
            n = n.copy(text=n.text.rstrip()[:-1].rstrip(), meta=dict(n.meta, period_dropped=True))
        out.append(n)
    report = {"tall_ratio": tall_ratio, "dropped": {k: v for k, v in dropped.items() if v},
              "final_period_removed": sum(1 for i in out if i.meta.get("period_dropped")),
              "xheight_from_session": resized}
    return out, report


def has_final_period(ink: Ink) -> bool:
    """False when the text ends with a full stop that was never written.

    Writers copying a sentence often leave the last dot out.  Trained on as it
    is, such a line teaches the network that a final "." may produce no ink.
    Expects xh units: a dot is a tiny stroke near the baseline at the right end.
    """
    text = ink.text.rstrip()
    if not text.endswith(".") or text.endswith(".."):
        return True
    dots, rest_right = [], -np.inf
    for s in prep.stroke_slices(ink.points):
        seg = ink.points[s, :2]
        (x0, y0), (x1, y1) = seg.min(axis=0), seg.max(axis=0)
        if x1 - x0 < 0.45 and y1 - y0 < 0.45 and -1.0 < (y0 + y1) / 2 < 1.5:    # dots sit up to 0.8 x-heights low
            dots.append((x0 + x1) / 2)
        else:
            rest_right = max(rest_right, x1)
    return any(x > rest_right - 1.5 for x in dots)     # a final letter's tail may reach past the dot


def resample_all(norm: list[Ink], step_xh: float, hint: dict | None = None) -> tuple[list[Ink], dict]:
    """Resample every source in time so that its median pen-down step is
    `step_xh` x-heights.  Sources differ in sampling rate, so each gets its own
    time step (found by a short secant search)."""
    by_src = collections.defaultdict(list)
    for ink in norm:
        by_src[ink.source].append(ink)
    used, final = {}, []
    for src, group in by_src.items():
        timed = "t" in group[0].meta
        if hint and src in hint:
            step = hint[src]["step"] * step_xh / hint[src]["median_step_xh"]
        else:
            if timed:
                dts = np.concatenate([np.diff(i.meta["t"])[i.points[:-1, 2] < 0.5] for i in group])
                dt0 = float(np.median(dts[dts > 0])) if (dts > 0).any() else 1.0
            else:
                dt0 = 1.0
            d0 = float(np.median(np.concatenate([prep.pen_down_steps(i.points) for i in group])))
            step = dt0 * step_xh / max(d0, 1e-9)
        for _ in range(4):
            res = [prep.resample_time(i, step) for i in group]
            d = float(np.median(np.concatenate([prep.pen_down_steps(i.points) for i in res])))
            if abs(d / step_xh - 1.0) < 0.02:
                break
            step *= step_xh / d
        used[src] = {"step": step, "timed": timed, "median_step_xh": d, "n": len(group)}
        final.extend(res)
    return final, used


def sanity_filter(inks: list[Ink]) -> tuple[list[Ink], dict]:
    kept, dropped = [], collections.Counter()
    for ink in inks:
        n_chars = max(len(ink.text.replace(" ", "")), 1)
        ppc = len(ink) / n_chars
        x0, y0, x1, y1 = ink.bbox()
        if ppc < 4 or ppc > 120:
            dropped["points-per-char"] += 1
        elif (y1 - y0) > (MAX_HEIGHT_LINE if ink.kind == "line" else MAX_HEIGHT_WORD) \
                or (x1 - x0) / n_chars > 6 or (x1 - x0) / n_chars < 0.12:
            dropped["size"] += 1
        else:
            kept.append(ink)
    return kept, dict(dropped)


def points_per_char(inks: list[Ink], calibration: str = "letters") -> float:
    """Median points per character.  "letters" counts the characters without
    spaces.  "chars" counts them as scripts/base_stats.py does for the base
    model (len(ink) / len(text), spaces included); a single word counts one
    more character, the space that follows it in running text."""
    v = []
    for i in inks:
        letters = len(i.text.replace(" ", ""))
        if letters < 3:
            continue
        n = letters if calibration == "letters" else len(i.text) + (i.kind != "line")
        v.append(len(i) / n)
    return float(np.median(v))


def calibrate(raw: list[Ink], base_stats: dict, verbose: bool = True, calibration: str = "letters",
              line_size: str = "session") -> tuple[list[Ink], dict]:
    """Prepare the recordings so that they look to the network like its
    pretraining data in the two respects its attention mechanism depends on:

      * points per character  (how fast the window moves along the text)
      * length of one pen step in model units

    Both follow from two free choices: the resampling step (in x-heights) and
    the scale `xh_model` (model units per x-height).  The step is set so that a
    character takes as many points as in the base model's own writing; the
    scale then makes one step as long as the base model's steps.  The writer's
    letters therefore come out a little smaller or larger than the average
    pretraining writer -- which is fine, sizes varied there too.

    `calibration` says how characters are counted (see points_per_char): the
    base statistics count spaces, "letters" does not and so ends at 22.4
    points per character including spaces (step_xh 0.156, xh_model 93);
    "chars" counts like the base statistics (step_xh 0.133, xh_model 110; the
    base's own x-height is 130).  `line_size`: see measure().
    """
    norm, report = measure(raw, line_size)
    target_ppc = base_stats["points_per_char"]
    step, hint = base_stats["step_median_xh"], None
    for _ in range(5):
        inks, hint = resample_all(norm, step, hint)
        # Real lines are the reference whenever there are enough of them, so that
        # every recipe (with or without the single words) sees the same lines.
        ref = [i for i in inks if i.kind == "line"]
        if len(ref) < 50:
            ref = [i for i in inks if i.kind == "word" and not i.text.isdigit()] or ref
        ppc = points_per_char(ref, calibration)
        if abs(ppc / target_ppc - 1.0) < 0.02:
            break
        step *= ppc / target_ppc
    inks, dropped = sanity_filter(inks)
    report["dropped"].update(dropped)
    base_step_model = base_stats["step_median_xh"] * base_stats["xh_model"]
    report.update(calibration=calibration, line_size=line_size, resampling=hint, points_per_char=ppc,
                  step_xh=step, xh_model=base_step_model / step,
                  counts=dict(collections.Counter(i.source for i in inks)))
    if verbose:
        print(json.dumps({k: v for k, v in report.items() if k != "resampling"}, indent=1))
    return inks, report


def calibrate_cached(raw: list[Ink], base_stats: dict, cache_dir: str, calibration: str = "letters",
                     line_size: str = "session") -> tuple[list[Ink], dict]:
    """calibrate() with a disk cache keyed by the recordings, the base
    statistics and the two modes."""
    import hashlib
    import os
    import pickle

    key = [PREP_VERSION, base_stats]
    if (calibration, line_size) != ("letters", "session"):    # the default keeps the key of existing caches
        key.append([calibration, line_size])
    h = hashlib.sha256(json.dumps(key, sort_keys=True).encode())
    for ink in sorted(raw, key=lambda i: i.id):
        h.update(f"{ink.id}:{len(ink)}:{ink.text}".encode())
    path = os.path.join(cache_dir, f"prepared_{h.hexdigest()[:16]}.pkl")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return pickle.load(f)
    result = calibrate(raw, base_stats, verbose=False, calibration=calibration, line_size=line_size)
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump(result, f)
    return result


# Largest |log(word width / (line's median width per character x characters))|
# a split may have.  Measured on the 155 capture and older lines that split at
# min_gap 0.8: the two lines written with a space the text does not have
# ("Tag # 2 ...", "Aufgabe # 3 ...") reach 1.58 and 1.81, every correct split at
# most 0.84 (lines full of digits and symbols such as "100 + 50 + 25 = 175");
# the correct splits found without the ambiguity rule (hw/train.py:
# Corpus.line_words) reach 0.94, the wrong ones 2.05 and more.
WORD_FIT_MAX = 1.2


def word_misfit(words: list[Ink]) -> float:
    """How badly the widths of the cut-out words fit their texts: the largest
    |log| of a word's width over the width its number of characters predicts
    at the line's median width per character.  A cut at a gap the text does
    not have shifts every following text by one word, and some word then comes
    out several times too wide or too narrow."""
    width = np.array([max(float(np.ptp(w.points[:, 0])), 1e-3) for w in words])
    n = np.array([len(w.text) for w in words])
    return float(np.max(np.abs(np.log(width / (np.median(width / n) * n)))))


def split_words(line: Ink, min_gap: float = 0.8, ambiguous: bool = False, check_fit: bool = True) -> list[Ink] | None:
    """Cut a real line into its words at the largest horizontal jumps between
    consecutive strokes (one cut per space in the text).  Returns None when the
    jumps do not single out the word gaps clearly, or when the words do not fit
    their texts (word_misfit; `check_fit` False leaves that test out, for ink
    whose text is not in doubt but whose letters may be: generated pieces).
    With `ambiguous` a next-largest jump nearly as large as the cuts is no
    reason to give up: the width check alone decides."""
    words = line.text.split()
    if len(words) < 2:
        return [line]
    sl = prep.stroke_slices(line.points)
    reach, jumps = float(line.points[sl[0], 0].max()), []
    for k in range(1, len(sl)):
        seg = line.points[sl[k]]
        jumps.append((float(seg[:, 0].min()) - reach, k))
        reach = max(reach, float(seg[:, 0].max()))
    n_cut = len(words) - 1
    ranked = sorted(jumps, reverse=True)
    if len(ranked) < n_cut or ranked[n_cut - 1][0] < min_gap:
        return None
    if not ambiguous and len(ranked) > n_cut and ranked[n_cut][0] > 0.75 * ranked[n_cut - 1][0]:
        return None                                   # next-largest jump is nearly as big: ambiguous
    cuts = sorted(k for _, k in ranked[:n_cut])
    bounds = [0] + [sl[k].start for k in cuts] + [len(line.points)]
    out = []
    for w, (lo, hi) in zip(words, zip(bounds[:-1], bounds[1:])):
        out.append(Ink(line.points[lo:hi].copy(), text=w, id=f"{line.id}/{len(out)}", source=line.source,
                       kind="word", meta={"line": line.id}))
    return out if not check_fit or word_misfit(out) <= WORD_FIT_MAX else None


def level_words(line: Ink) -> Ink:
    """A recorded line with every word set on the line (xh units, baseline at
    y = 0): each word moves up or down as a whole, by prep.word_level.

    Nobody writes a whole line dead level, and the network learns that
    unevenness and adds its own when it writes freely.  Whole words keep their
    shape; a line whose words cannot be told apart stays as it is."""
    words = split_words(line, min_gap=0.6)
    if not words:
        return line
    size = prep.extremes(line.copy(kind="line"))[2]
    p, start = line.points.copy(), 0
    for w in words:
        p[start:start + len(w.points), 1] -= prep.word_level(w, size)
        start += len(w.points)
    return line.copy(points=p)


def line_chunks(line: Ink, max_points: int = None, max_chars: int = 34) -> list[Ink]:
    """Real line -> pieces of consecutive words that fit the training length.
    The words keep their true positions, so spacing and baseline are real."""
    max_points = max_points or MAX_POINTS
    words = split_words(line)
    if words is None:
        return [line] if len(line) <= max_points else []
    chunks, cur = [], []
    for w in words:
        n_pts = sum(len(c) for c in cur) + len(w)
        n_chr = sum(len(c.text) + 1 for c in cur) + len(w.text)
        if cur and (n_pts > max_points or n_chr > max_chars):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    out = []
    for k, c in enumerate(chunks):
        pts = np.vstack([w.points for w in c])
        pts[:, 0] -= pts[:, 0].min()
        out.append(Ink(pts, text=" ".join(w.text for w in c), id=f"{line.id}#{k}", source=line.source,
                       kind="line", meta={"line": line.id}))
    return out


# -------------------------------------------------------------------- splitting
def stable_fraction(key: str) -> float:
    return (zlib.crc32(key.encode("utf-8")) % 10_000) / 10_000.0


def split(inks: list[Ink], val_fraction: float = 0.08, val_lines: int | None = None, train_all: bool = False):
    """Hold out whole *texts* (so a word written several times never straddles
    the split) and some real lines (8 %, at least 4) to measure against.

    Held-out lines come from the capture app only (older lines are written a
    little differently and would blur the measurement), and never contain a
    character that is rare in the corpus: with two examples of a capital
    umlaut, holding one out would take half of what there is to learn from.
    The same holds for single words, counted over all recordings.  With
    `train_all` nothing is held out."""
    if train_all:
        return list(inks), []
    lines = [i for i in inks if i.kind == "line"]
    counts = collections.Counter(c for i in lines for c in i.text if not c.isspace())
    capture = [i for i in lines if i.source in sources.CAPTURE_SOURCES]
    eligible = [i for i in (capture if len(capture) >= 30 else lines)
                if all(counts[c] >= RARE_CHAR_COUNT for c in i.text if not c.isspace())]
    eligible.sort(key=lambda i: stable_fraction(i.text))
    if val_lines is None:
        val_lines = max(4, round(val_fraction * len(lines)))
    val_line_ids = {i.id for i in eligible[:val_lines]} if len(lines) >= 3 * val_lines else set()
    every = collections.Counter(c for i in inks for c in i.text if not c.isspace())
    train, val = [], []
    for ink in inks:
        if ink.kind == "line":
            (val if ink.id in val_line_ids else train).append(ink)
        elif stable_fraction(ink.text.lower()) < val_fraction and all(every[c] >= RARE_CHAR_COUNT for c in ink.text):
            val.append(ink)
        else:
            train.append(ink)
    return train, val


# ------------------------------------------------------------------ composition
class LineComposer:
    """Lays single words out as lines of text.

    The recordings are mostly isolated words, but the model has to write whole
    lines.  A composed line is `word gap word gap ...` on a common baseline;
    the gap widths follow the writer's own spacing measured on real lines.
    """

    def __init__(self, words: list[Ink], gap_mean: float = 1.6, gap_sd: float = 0.35,
                 max_points: int = MAX_POINTS, max_chars: int = 34, seed: int = 0,
                 special_chars: str = "", special_share: float = 0.0):
        self.words = words
        self.gap_mean, self.gap_sd = gap_mean, gap_sd
        self.max_points, self.max_chars = max_points, max_chars
        self.rng = np.random.default_rng(seed)
        self.digits = [w for w in words if w.text.isdigit() and len(w.text) <= 5]
        self.letters = [w for w in words if not w.text.isdigit()]
        # words with characters the pretrained network has never seen (umlauts,
        # sharp s ...) are drawn more often: there are few of them and each new
        # character has to be learned from scratch
        self.special = [w for w in self.letters if any(c in special_chars for c in w.text)]
        self.special_share = special_share if self.special else 0.0

    def compose(self, parts: list[Ink], rng=None) -> Ink:
        rng = rng or self.rng
        pts, x, texts = [], 0.0, []
        drift = rng.normal(0.0, 0.012)                    # slight baseline slope
        for w in parts:
            p = w.points.copy()
            size = float(np.exp(rng.normal(0.0, 0.04)))   # words keep slightly different sizes
            p[:, :2] *= size
            p[:, 0] += x - p[:, 0].min()
            p[:, 1] += rng.normal(0.0, 0.05) + drift * x
            pts.append(p)
            x = float(p[:, 0].max()) + max(0.5, rng.normal(self.gap_mean, self.gap_sd))
            texts.append(w.text)
        return Ink(np.vstack(pts), text=" ".join(texts), kind="line", source="composed",
                   id="+".join(w.id for w in parts))

    def sample(self, rng=None) -> Ink:
        rng = rng or self.rng
        n_target = int(rng.integers(1, 6))
        parts, n_pts, n_chars = [], 0, 0
        for _ in range(n_target):
            r = rng.random()
            if self.digits and r < 0.08:
                pool = self.digits
            elif r < 0.08 + self.special_share:
                pool = self.special
            else:
                pool = self.letters
            w = pool[int(rng.integers(len(pool)))]
            if parts and (n_pts + len(w) > self.max_points or n_chars + len(w.text) + 1 > self.max_chars):
                break
            parts.append(w)
            n_pts += len(w)
            n_chars += len(w.text) + 1
        return self.compose(parts, rng)

    def fixed(self, n: int, seed: int = 1234) -> list[Ink]:
        rng = np.random.default_rng(seed)
        return [self.sample(rng) for _ in range(n)]


def measure_gaps(lines: list[Ink]) -> tuple[float, float]:
    """Word gap (xh units) of real lines: the n largest horizontal jumps between
    consecutive strokes, n = number of spaces in the text."""
    gaps = []
    for ink in lines:
        n_sp = ink.text.count(" ")
        if n_sp == 0:
            continue
        strokes = ink.strokes()
        reach, jumps = strokes[0][:, 0].max(), []
        for s in strokes[1:]:
            jumps.append(float(s[:, 0].min() - reach))
            reach = max(reach, float(s[:, 0].max()))
        jumps = sorted(jumps, reverse=True)[:n_sp]
        gaps += [j for j in jumps if j > 0.2]
    if len(gaps) < 5:
        return 1.6, 0.35
    return float(np.median(gaps)), float(np.std(gaps))


# ------------------------------------------------------------------- to tensors
def augment(points: np.ndarray, rng, shape: float = 1.0, place: float = 1.0) -> np.ndarray:
    """Small random changes that keep the hand recognisable: width and slant
    (scaled by `shape`), size and a hint of rotation (scaled by `place`; these
    two change how large a piece is and whether it runs uphill, which is what
    makes pieces of one page differ)."""
    p = points.copy()
    s = float(np.exp(rng.normal(0.0, 0.05 * place)))
    sx = float(np.exp(rng.normal(0.0, 0.04 * shape)))
    shear = float(rng.normal(0.0, 0.05 * shape))
    rot = float(rng.normal(0.0, 0.015 * place))
    x, y = p[:, 0] * s * sx, p[:, 1] * s
    x = x - shear * y                                  # y is down: positive shear leans right
    p[:, 0] = x * np.cos(rot) - y * np.sin(rot)
    p[:, 1] = x * np.sin(rot) + y * np.cos(rot)
    return p


def to_model(ink: Ink, xh_model: float, mu, std, max_points: int = MAX_POINTS) -> np.ndarray:
    """xh-unit ink -> normalised offset sequence (T,3) for the network."""
    pts = ink.points.copy()
    pts[:, :2] *= xh_model
    off = to_offsets(pts)[:max_points]
    off[-1, 2] = 1.0
    off[:, :2] = (off[:, :2] - np.asarray(mu[:2], dtype=np.float32)) / np.asarray(std[:2], dtype=np.float32)
    return off.astype(np.float32)

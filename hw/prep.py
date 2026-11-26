"""Turn raw recordings into training sequences.

Pipeline per recording
    clean -> estimate baseline -> (per session) estimate x-height
          -> scale so x-height = 1, baseline at y = 0, text starts at x = 0
          -> resample in time so the point density matches the base model

After this every ink lives in "xh units": 1.0 = the writer's x-height.  The
model works in the units of its pretraining data; the single constant
`xh_model` (model units per x-height, measured on the base model's own
output) connects the two.

Why per session?  A writer keeps a fairly constant letter size within one
sitting, while a single short word ("ging", "594") often cannot reveal its
own x-height.  Pooling the measurements of a session is robust, and it keeps
the natural size variation between words.
"""
from __future__ import annotations

import numpy as np

from .ink import Ink

# ------------------------------------------------------------------- cleaning


def clean(ink: Ink) -> Ink | None:
    """Drop non-finite and exactly repeated points (keeps stroke ends)."""
    p = ink.points
    t = ink.meta.get("t")
    ok = np.isfinite(p).all(axis=1)
    if not ok.all():
        # make sure a removed stroke end hands its flag to the previous point
        for i in np.flatnonzero(~ok):
            if p[i, 2] > 0.5 and i > 0:
                p[i - 1, 2] = 1.0
        p = p[ok]
        t = t[ok] if t is not None else None
    if len(p) < 2:
        return None
    same = np.zeros(len(p), dtype=bool)
    same[1:] = (p[1:, 0] == p[:-1, 0]) & (p[1:, 1] == p[:-1, 1]) & (p[:-1, 2] < 0.5)
    if same.any():
        # a repeated point that ends a stroke: move the flag back
        for i in np.flatnonzero(same):
            if p[i, 2] > 0.5:
                j = i - 1
                while j >= 0 and same[j]:
                    j -= 1
                p[j, 2] = 1.0
        p = p[~same]
        t = t[~same] if t is not None else None
    meta = dict(ink.meta)
    if t is not None:
        meta["t"] = t
    return ink.copy(points=p, meta=meta)


def stroke_slices(points: np.ndarray) -> list[slice]:
    ends = np.flatnonzero(points[:, 2] > 0.5)
    out, start = [], 0
    for e in ends:
        out.append(slice(start, e + 1))
        start = e + 1
    if start < len(points):
        out.append(slice(start, len(points)))
    return out


# ----------------------------------------------------------- baseline, height


def turning_points(y: np.ndarray, delta: float) -> tuple[list[int], list[int]]:
    """Indices of local tops (min y) and bottoms (max y) of one stroke, ignoring
    wiggles smaller than `delta` (zig-zag filter).  Stroke ends count."""
    n = len(y)
    tops: list[int] = []
    bottoms: list[int] = []
    lo = hi = 0          # running extremes since the last confirmed turning point
    direction = 0        # +1 heading down the screen (y grows), -1 heading up
    for i in range(1, n):
        if direction == 0:
            if y[i] > y[hi]:
                hi = i
            if y[i] < y[lo]:
                lo = i
            if y[hi] - y[lo] > delta:
                if hi > lo:                  # moved down first: the start was a top
                    tops.append(lo)
                    direction = 1
                else:
                    bottoms.append(hi)
                    direction = -1
        elif direction == 1:
            if y[i] > y[hi]:
                hi = i
            elif y[hi] - y[i] > delta:       # turned upwards: hi was a bottom
                bottoms.append(hi)
                direction = -1
                lo = i
        else:
            if y[i] < y[lo]:
                lo = i
            elif y[i] - y[lo] > delta:       # turned downwards: lo was a top
                tops.append(lo)
                direction = 1
                hi = i
    # the last leg ends in an extreme; flat strokes (dots, dashes) have none
    if direction == 1:
        bottoms.append(hi)
    elif direction == -1:
        tops.append(lo)
    return tops, bottoms


def _kde_mode(v: np.ndarray, bw: float, w: np.ndarray | None = None) -> float:
    if len(v) == 1:
        return float(v[0])
    grid = np.linspace(v.min(), v.max(), 200)
    d = np.exp(-0.5 * ((grid[:, None] - v[None, :]) / bw) ** 2)
    if w is not None:
        d = d * w[None, :]
    return float(grid[int(np.argmax(d.sum(axis=1)))])


def extremes(ink: Ink) -> tuple[np.ndarray, np.ndarray, float]:
    """(tops, bottoms) as (n,2) arrays of x,y and the size used as tolerance."""
    p = ink.points
    size = max(float(np.ptp(p[:, 1])), 1e-6)
    if ink.kind == "line":           # a drifting line inflates the bounding box
        hs = [float(np.ptp(p[s, 1])) for s in stroke_slices(p)]
        size = max(float(np.percentile(hs, 90)), 1e-6) * 1.3
    delta = 0.08 * size
    tops, bottoms = [], []
    for s in stroke_slices(p):
        seg = p[s, :2]
        if len(seg) < 3 or np.hypot(*np.diff(seg, axis=0).T).sum() < 0.3 * size:
            continue                 # dots and short dashes say nothing about letter size
        t, b = turning_points(p[s, 1], delta)
        tops += [p[s][i, :2] for i in t]
        bottoms += [p[s][i, :2] for i in b]
    return np.array(tops).reshape(-1, 2), np.array(bottoms).reshape(-1, 2), size


def baseline(ink: Ink) -> tuple[float, float, float]:
    """Robust baseline y = a*x + b through the bottoms of the letters.
    Returns (a, b, size).  Short inks get a horizontal baseline."""
    _, bottoms, size = extremes(ink)
    bw = 0.07 * size
    if len(bottoms) == 0:            # only dots/dashes: fall back to the lower edge
        return 0.0, float(ink.points[:, 1].max()), size
    x, y = bottoms[:, 0], bottoms[:, 1]
    width = float(np.ptp(ink.points[:, 0]))
    a = 0.0
    if ink.kind == "line" and len(x) >= 8 and width > 4 * size:
        # Theil-Sen slope, then keep the dominant band of bottoms
        i, j = np.triu_indices(len(x), k=1)
        dx = x[j] - x[i]
        ok = np.abs(dx) > 0.5 * size
        if ok.sum() >= 10:
            a = float(np.median((y[j] - y[i])[ok] / dx[ok]))
    b = _kde_mode(y - a * x, bw)
    for _ in range(3):
        r = y - (a * x + b)
        near = np.abs(r) < 1.5 * bw
        if near.sum() < 2:
            break
        if ink.kind == "line" and near.sum() >= 6 and np.ptp(x[near]) > 4 * size:
            a, b = np.polyfit(x[near], y[near], 1)
            a, b = float(a), float(b)
        else:
            b = float(np.mean((y - a * x)[near]))
    a = float(np.clip(a, -0.2, 0.2))
    return a, b, size


DOT_MAX_LENGTH = 0.5     # xh; longer short strokes are the bars of t and f, dashes, parts of capitals
DOT_MIN_HEIGHT = 1.15    # xh above the baseline: clear of the small letters


def dot_strokes(ink: Ink) -> int:
    """How many dots a written line has (ink in xh units): very short strokes
    well above the small letters, that is the dots of i, j, ä, ö and ü.

    On the writer's own lines the count equals i + j + 2 x umlauts in 83 % of
    the lines, is higher in 16 % (the upper dot of a colon between tall digits,
    small parts of digits and capitals) and lower in 1 %."""
    a, b, _ = baseline(ink.copy(kind="line"))
    n = 0
    for s in stroke_slices(ink.points):
        seg = ink.points[s, :2]
        length = float(np.hypot(*np.diff(seg, axis=0).T).sum()) if len(seg) > 1 else 0.0
        height = float(np.mean((a * seg[:, 0] + b) - seg[:, 1]))
        if length < DOT_MAX_LENGTH and height > DOT_MIN_HEIGHT:
            n += 1
    return n


DEEP_CHARS = "gjpqyfzßJGYQ,;()[]/§79!?@"  # may reach well below the baseline, depending on the hand
MAX_PLAIN_DEPTH = 1.5                     # xh below the line; no other character goes that deep (page.stray_depth)


LEVEL_KEEP = 0.12      # xh a word may sit above or below the line: the natural unevenness stays


def word_level(word: Ink, size: float) -> float:
    """How far (xh, positive = down) a word of a straightened piece has to move
    up to sit on the line again.

    The network sometimes sets a whole word a little higher or lower than its
    neighbours.  The level of a word is where most of its letters end at the
    bottom (as in baseline, with the piece's `size` as tolerance).  Words
    of fewer than three characters or with fewer than three such bottoms are
    left alone, and so is a level further off than a word can plausibly be
    (0.9 xh if the word has descenders, whose ends could be mistaken for the
    level, else 1.5): that is a failed sample, not an uneven line."""
    if len(word.text) < 3:
        return 0.0
    delta, bw = 0.08 * size, 0.07 * size
    ys = []
    for s in stroke_slices(word.points):
        seg = word.points[s, :2]
        if len(seg) < 3 or np.hypot(*np.diff(seg, axis=0).T).sum() < 0.3 * size:
            continue
        _, bottoms = turning_points(word.points[s, 1], delta)
        ys += [float(seg[i, 1]) for i in bottoms]
    if len(ys) < 3:
        return 0.0
    ys = np.asarray(ys)
    b = _kde_mode(ys, bw)
    near = np.abs(ys - b) < 1.5 * bw
    if near.sum() >= 2:
        b = float(ys[near].mean())
    if abs(b) > (0.9 if any(c in DEEP_CHARS for c in word.text) else 1.5):
        return 0.0
    return float(b - np.clip(b, -LEVEL_KEEP, LEVEL_KEEP))


def top_heights(ink: Ink, a: float, b: float) -> np.ndarray:
    """Heights of all letter tops above the baseline (positive = above)."""
    tops, _, _ = extremes(ink)
    return (a * tops[:, 0] + b) - tops[:, 1]


def session_xheight(heights: np.ndarray) -> tuple[float, float]:
    """x-height and ascender height from the pooled top heights of a session.

    The tops of small letters (a c e m n o r s u ...) pile up at the x-height,
    those of b d h k l and capitals at the ascender height.  We take the lowest
    strong mode as x-height and the strongest mode above it as ascender height.
    """
    h = heights[np.isfinite(heights)]
    h = h[h > 0]
    if len(h) < 5:
        return float("nan"), float("nan")
    scale = float(np.median(h))
    h = h[h < 4 * scale]
    grid = np.linspace(0.25 * scale, 3.2 * scale, 600)
    bw = 0.06 * scale
    dens = np.exp(-0.5 * ((grid[:, None] - h[None, :]) / bw) ** 2).sum(axis=1)
    peaks = [i for i in range(1, len(grid) - 1) if dens[i] >= dens[i - 1] and dens[i] > dens[i + 1]]
    if not peaks:
        return scale, float("nan")
    strongest = max(dens[i] for i in peaks)
    strong = [i for i in peaks if dens[i] >= 0.35 * strongest]
    xh_i = strong[0]
    xh = float(grid[xh_i])
    above = [i for i in peaks if grid[i] > 1.3 * xh and grid[i] < 2.6 * xh]
    asc = float(grid[max(above, key=lambda i: dens[i])]) if above else float("nan")
    return xh, asc


TALL = set("bdfhkltßBDFHKLT0123456789") | set("ACEGIJMNOPQRSUVWXYZÄÖÜ")
SMALL = set("aceimnorsuvwxzäöü") | set("gjpqy")
TWO_STEMS = set("HMNKAWUVÄÜ")          # capitals that usually reach full height twice


def text_classes(text: str) -> tuple[bool, bool]:
    """(has small letters, has tall letters/capitals/digits)."""
    return any(c in SMALL for c in text), any(c in TALL for c in text)


def tall_arches_expected(text: str) -> int:
    return sum((2 if c in TWO_STEMS else 1) for c in text if c in TALL)


def letter_heights(ink: Ink, a: float, b: float) -> np.ndarray:
    """Peak heights of the "arches" of the writing above the baseline.

    An arch is a stretch of pen-down writing between two visits to the baseline
    (or a stroke end).  Every letter body produces one or more arches whose
    peak is the letter's height: small letters peak at the x-height, ascenders,
    capitals and digits higher.  Wiggles and connecting strokes at half height
    do not come back to the baseline and therefore create no arch of their own
    -- which is what makes this a much cleaner size signal than local maxima.
    Strokes that never come near the baseline (dots, bars, accents) are ignored.
    """
    p = ink.points
    h = (a * p[:, 0] + b) - p[:, 1]
    pos = h[h > 0]
    if len(pos) == 0:
        return np.zeros(0)
    scale = 0.4 * float(np.percentile(pos, 95))
    peaks = np.zeros(0)
    for _ in range(2):
        found = []
        for s in stroke_slices(p):
            hs = h[s]
            if hs.min() > 0.5 * scale:
                continue
            above = (hs > 0.3 * scale).astype(np.int8)
            edges = np.flatnonzero(np.diff(np.concatenate([[0], above, [0]])))
            for st, en in zip(edges[::2], edges[1::2]):
                found.append(float(hs[st:en].max()))
        peaks = np.array(found)
        if len(peaks) < 3:
            break
        scale = float(np.median(peaks))
    return peaks


def fit_xheight(heights: np.ndarray, text: str, tall_ratio: float) -> float:
    """x-height of ONE ink from its arch heights (see letter_heights).

    Writers change letter size from word to word (short words get written
    bigger), so every ink has to reveal its own size -- and ascenders vary far
    too much (2.4 to 4 x-heights in this hand) to derive it from the total
    height.  Instead the text tells us how many tall letters there are; their
    arches are the tallest ones.  Setting those aside leaves the small letters,
    whose arch heights cluster tightly at the x-height.
    """
    h = np.sort(heights[np.isfinite(heights) & (heights > 0)])
    if len(h) == 0:
        return float("nan")
    has_small, has_tall = text_classes(text)
    if not has_small and has_tall:                     # digits, "EU", ...
        return float(np.median(h)) / tall_ratio
    n_tall = min(tall_arches_expected(text), len(h) - 2)
    rest = h[: len(h) - n_tall] if n_tall > 0 else h
    if len(rest) < 2:
        return float(np.median(h)) / (tall_ratio if has_tall else 1.0)
    lg = np.log(rest)
    grid = np.linspace(lg.min(), lg.max(), 120)
    dens = np.exp(-0.5 * ((grid[:, None] - lg[None, :]) / 0.14) ** 2).sum(axis=1)
    return float(np.exp(grid[int(np.argmax(dens))]))


# ------------------------------------------------------------------ resampling


def resample_time(ink: Ink, step: float) -> Ink:
    """Resample every stroke at a constant time step.

    With real timestamps `step` is in milliseconds; without them the point
    index is used as time (the recorder sampled at a fixed rate) and `step` is
    a number of original samples.  The trajectory is low-pass filtered first so
    that decimation does not alias digitizer noise; stroke ends are kept.
    """
    p = ink.points
    t_all = ink.meta.get("t")
    out = []
    for s in stroke_slices(p):
        xy = p[s, :2].astype(np.float64)
        n = len(xy)
        if t_all is not None:
            t = np.asarray(t_all[s], dtype=np.float64)
            t = t - t[0]
            if n > 1 and not np.all(np.diff(t) > 0):     # repair non-increasing stamps
                t = np.maximum.accumulate(t)
                t = t + np.arange(n) * 1e-3
        else:
            t = np.arange(n, dtype=np.float64)
        if n == 1 or t[-1] <= 0:
            out.append([xy[0, 0], xy[0, 1], 1.0])
            continue
        dur = t[-1]
        m = max(int(round(dur / step)), 1)
        tt = np.linspace(0.0, dur, m + 1)
        # low-pass: box filter of one output step, evaluated by integrating the
        # piecewise-linear trajectory (cumulative trapezoid)
        cx = np.concatenate([[0.0], np.cumsum(0.5 * (xy[1:, 0] + xy[:-1, 0]) * np.diff(t))])
        cy = np.concatenate([[0.0], np.cumsum(0.5 * (xy[1:, 1] + xy[:-1, 1]) * np.diff(t))])
        half = 0.5 * dur / m
        lo = np.clip(tt - half, 0.0, dur)
        hi = np.clip(tt + half, 0.0, dur)

        def integ(c, v, q):
            base = np.interp(q, t, c)
            # exact integral of the linear piece: use quadratic correction
            idx = np.clip(np.searchsorted(t, q, side="right") - 1, 0, n - 2)
            t0, t1 = t[idx], t[idx + 1]
            v0, v1 = v[idx], v[idx + 1]
            frac = np.where(t1 > t0, (q - t0) / np.where(t1 > t0, t1 - t0, 1.0), 0.0)
            exact = c[idx] + (q - t0) * (v0 + 0.5 * frac * (v1 - v0))
            return np.where(np.isfinite(exact), exact, base)

        w = np.maximum(hi - lo, 1e-9)
        x = (integ(cx, xy[:, 0], hi) - integ(cx, xy[:, 0], lo)) / w
        y = (integ(cy, xy[:, 1], hi) - integ(cy, xy[:, 1], lo)) / w
        x[0], y[0] = xy[0]
        x[-1], y[-1] = xy[-1]
        e = np.zeros(m + 1)
        e[-1] = 1.0
        out.extend(np.column_stack([x, y, e]).tolist())
    meta = {k: v for k, v in ink.meta.items() if k != "t"}
    return ink.copy(points=np.array(out, dtype=np.float32), meta=meta)


def pen_down_steps(points: np.ndarray) -> np.ndarray:
    d = np.hypot(np.diff(points[:, 0]), np.diff(points[:, 1]))
    return d[points[:-1, 2] < 0.5]


# ------------------------------------------------------------- normalisation


def to_xh_units(ink: Ink, a: float, b: float, xh: float) -> Ink:
    """Remove baseline slope, put the baseline at y=0 and the left edge at x=0,
    scale so that the x-height is 1."""
    p = ink.points.copy()
    p[:, 1] = p[:, 1] - (a * p[:, 0] + b)
    p[:, 0] = p[:, 0] - p[:, 0].min()
    p[:, :2] /= xh
    return ink.copy(points=p)

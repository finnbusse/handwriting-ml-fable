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

from . import prep
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
SESSION_XH_TOLERANCE = 0.15   # a line's x-height may differ this much from its session's median
MAX_HEIGHT_WORD = 9.0         # x-heights; taller recordings are measured wrongly or scribbles
MAX_HEIGHT_LINE = 12.0        # a line adds baseline drift and tall brackets
PREP_VERSION = 7         # bump when the preparation changes (invalidates the cache)


def measure(raw: list[Ink]) -> tuple[list[Ink], dict]:
    """Clean every recording, find its baseline and x-height and bring it into
    xh units (baseline y=0, x-height 1, left edge x=0).  Not yet resampled."""
    inks = [c for c in (prep.clean(i) for i in raw) if c is not None]

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

    # 3. per-ink x-height -> xh units.  Lines of one capture session are written
    #    on the same sheet in one go, so their x-heights agree closely.  The
    #    estimate of a single line depends on which letters it happens to hold,
    #    so it is kept within a narrow band around the session's median.
    sizes = {}
    for ink in inks:
        a, b, h = geo[ink.id]
        ratio = tall_ratio * (DIGIT_RATIO if ink.text.replace(" ", "").isdigit() else 1.0)
        sizes[ink.id] = prep.fit_xheight(h, ink.text, ratio)
    sessions = collections.defaultdict(list)
    for ink in inks:
        if ink.kind == "line" and ink.meta.get("session") and np.isfinite(sizes[ink.id]) and sizes[ink.id] > 0:
            sessions[(ink.source, ink.meta["session"])].append(sizes[ink.id])
    resized = 0
    for ink in inks:
        group = sessions.get((ink.source, ink.meta.get("session"))) if ink.kind == "line" else None
        if group and len(group) >= 4:
            med = float(np.median(group))
            own = sizes[ink.id]
            if not np.isfinite(own) or own <= 0:
                sizes[ink.id] = med
                resized += 1
            elif abs(own / med - 1.0) > SESSION_XH_TOLERANCE:
                sizes[ink.id] = float(np.clip(own, med * (1 - SESSION_XH_TOLERANCE), med * (1 + SESSION_XH_TOLERANCE)))
                resized += 1

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
        if x1 - x0 < 0.45 and y1 - y0 < 0.45 and -0.6 < (y0 + y1) / 2 < 0.5:
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


def points_per_char(inks: list[Ink]) -> float:
    v = [len(i) / len(i.text.replace(" ", "")) for i in inks if len(i.text.replace(" ", "")) >= 3]
    return float(np.median(v))


def calibrate(raw: list[Ink], base_stats: dict, verbose: bool = True) -> tuple[list[Ink], dict]:
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
    """
    norm, report = measure(raw)
    target_ppc = base_stats["points_per_char"]
    step, hint = base_stats["step_median_xh"], None
    for _ in range(5):
        inks, hint = resample_all(norm, step, hint)
        ref = [i for i in inks if i.kind == "word" and not i.text.isdigit()]
        if len(ref) < 50:                # a corpus of whole lines only
            ref = [i for i in inks if i.kind == "line"]
        ppc = points_per_char(ref)
        if abs(ppc / target_ppc - 1.0) < 0.02:
            break
        step *= ppc / target_ppc
    inks, dropped = sanity_filter(inks)
    report["dropped"].update(dropped)
    base_step_model = base_stats["step_median_xh"] * base_stats["xh_model"]
    report.update(resampling=hint, points_per_char=ppc, step_xh=step, xh_model=base_step_model / step,
                  counts=dict(collections.Counter(i.source for i in inks)))
    if verbose:
        print(json.dumps({k: v for k, v in report.items() if k != "resampling"}, indent=1))
    return inks, report


def calibrate_cached(raw: list[Ink], base_stats: dict, cache_dir: str) -> tuple[list[Ink], dict]:
    """calibrate() with a disk cache keyed by the recordings and the base statistics."""
    import hashlib
    import os
    import pickle

    h = hashlib.sha256(json.dumps([PREP_VERSION, base_stats], sort_keys=True).encode())
    for ink in sorted(raw, key=lambda i: i.id):
        h.update(f"{ink.id}:{len(ink)}:{ink.text}".encode())
    path = os.path.join(cache_dir, f"prepared_{h.hexdigest()[:16]}.pkl")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return pickle.load(f)
    result = calibrate(raw, base_stats, verbose=False)
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump(result, f)
    return result


def split_words(line: Ink, min_gap: float = 0.8) -> list[Ink] | None:
    """Cut a real line into its words at the largest horizontal jumps between
    consecutive strokes (one cut per space in the text).  Returns None when the
    jumps do not single out the word gaps clearly."""
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
    if len(ranked) > n_cut and ranked[n_cut][0] > 0.75 * ranked[n_cut - 1][0]:
        return None                                   # next-largest jump is nearly as big: ambiguous
    cuts = sorted(k for _, k in ranked[:n_cut])
    bounds = [0] + [sl[k].start for k in cuts] + [len(line.points)]
    out = []
    for w, (lo, hi) in zip(words, zip(bounds[:-1], bounds[1:])):
        out.append(Ink(line.points[lo:hi].copy(), text=w, id=f"{line.id}/{len(out)}", source=line.source,
                       kind="word", meta={"line": line.id}))
    return out


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


def split(inks: list[Ink], val_fraction: float = 0.08, val_lines: int | None = None):
    """Hold out whole *texts* (so a word written several times never straddles
    the split) and some real lines (8 %, at least 4) to measure against."""
    lines = sorted([i for i in inks if i.kind == "line"], key=lambda i: stable_fraction(i.text))
    if val_lines is None:
        val_lines = max(4, round(val_fraction * len(lines)))
    val_line_ids = {i.id for i in lines[:val_lines]} if len(lines) >= 3 * val_lines else set()
    train, val = [], []
    for ink in inks:
        if ink.kind == "line":
            (val if ink.id in val_line_ids else train).append(ink)
        elif stable_fraction(ink.text.lower()) < val_fraction:
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
def augment(points: np.ndarray, rng) -> np.ndarray:
    """Small random changes that keep the hand recognisable: size, width,
    slant and a hint of rotation."""
    p = points.copy()
    s = float(np.exp(rng.normal(0.0, 0.05)))
    sx = float(np.exp(rng.normal(0.0, 0.04)))
    shear = float(rng.normal(0.0, 0.05))
    rot = float(rng.normal(0.0, 0.015))
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

"""Lay out longer text as a page of handwriting.

The network writes one short piece at a time (it is trained on pieces of real
lines of about 17 to 31 characters and is steadiest on the shorter ones).  A page is built by
  1. splitting the text into such pieces at word boundaries,
  2. writing all pieces,
  3. straightening each piece on its own baseline and
  4. setting the pieces one after another, every word on the line, with the
     writer's own word spacing, wrapping at the page width.

Everything here is in xh units (1.0 = x-height, y down).  The same algorithm
runs in the browser (web/js/generate/layout.js); scripts/make_engine_fixture.py
exports reference results.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import dataset, prep
from .ink import Ink

# Longest piece written in one go.  Shorter pieces come out sounder: measured on
# the steadiest model, 13 % of the text sat in a faulty first attempt with
# pieces of up to 27 characters (pen off the line in 1.2 %), 8 % (0.3 %) with 22
# and 6 % with 18, and the retries of failed pieces cost less.  22 keeps two to
# four words together, so most word spacing is still the network's own.
MAX_PIECE_CHARS = 22


def split_pieces(text: str, max_chars: int = MAX_PIECE_CHARS) -> list[list[str]]:
    """Text -> paragraphs -> pieces.  A piece is one or more whole words; a word
    longer than max_chars becomes a piece of its own (the network copes with
    somewhat longer pieces, it just has seen fewer of them)."""
    paragraphs = []
    for para in text.replace("\r", "").split("\n"):
        pieces, cur = [], ""
        for word in para.split():
            if cur and len(cur) + 1 + len(word) > max_chars:
                pieces.append(cur)
                cur = word
            else:
                cur = f"{cur} {word}" if cur else word
        if cur:
            pieces.append(cur)
        paragraphs.append(pieces)
    return paragraphs


def straighten(ink: Ink) -> Ink:
    """Put a written piece on the baseline y=0 with its left edge at x=0."""
    probe = ink.copy(kind="line")
    a, b, _ = prep.baseline(probe)
    p = ink.points.copy()
    p[:, 1] -= a * p[:, 0] + b
    p[:, 0] -= p[:, 0].min()
    return ink.copy(points=p)


@dataclass
class Page:
    ink: Ink                       # all strokes in page coordinates (xh units)
    width: float
    height: float
    lines: int
    words: list[dict] = field(default_factory=list)    # text, x, y, width, ok


def piece_words(piece: Ink) -> list[Ink]:
    """A written piece cut into its words (at the widest gaps between strokes),
    so that lines can break between any two words.  If the gaps are not clear
    enough the piece stays whole."""
    words = dataset.split_words(piece.copy(kind="line"), min_gap=0.6)
    return words if words else [piece]


def levelled_words(piece: Ink) -> list[tuple[Ink, float]]:
    """The words of a straightened piece, each with the distance it has to move
    up to sit on the line (prep.word_level)."""
    size = prep.extremes(piece.copy(kind="line"))[2]
    return [(w, prep.word_level(w, size)) for w in piece_words(piece)]


def stray_depth(piece: Ink, where: np.ndarray) -> float:
    """How far below the line (xh) the pen went while writing characters that
    have no descender, after every word has been set on the line: the sign of
    a sample whose pen slid away inside a word.  `piece` is straightened, its
    text normalized; `where[i]` is the index into the text of the character
    the network was writing at point i (larger: the sentinel after the text).
    A descender also excuses the characters right next to it, the window is
    never exactly on one letter.

    On the writer's own lines, cut into pieces as the page writer does and
    aligned with the network's attention, the value stays below 1.3 in 99 % of
    the pieces; prep.MAX_PLAIN_DEPTH is the limit."""
    deep = np.array([c in prep.DEEP_CHARS for c in piece.text] + [False], dtype=bool)
    near = deep.copy()
    near[1:] |= deep[:-1]
    near[:-1] |= deep[1:]
    plain = ~near[np.minimum(np.asarray(where, dtype=np.int64), len(near) - 1)]
    if len(plain) != len(piece.points) or not plain.any():
        return 0.0
    depth, start = piece.points[:, 1].copy(), 0
    for w, level in levelled_words(piece):
        depth[start:start + len(w.points)] -= level
        start += len(w.points)
    return float(max(depth[plain].max(), 0.0))


SIZE_BIASES = (0.0, 0.4, 0.8, 1.2)
SIZE_TEXTS = [
    "Heute ist ein schöner Tag.", "Wir sehen uns morgen", "in der neuen Schule.", "Kannst du mir bitte helfen?",
    "Das Wetter wird am Sonntag", "wieder etwas besser.", "Ich habe den Bus verpasst.", "Viele Grüße und bis bald!",
    "Der Kuchen steht dort", "auf dem runden Tisch.", "Wir treffen uns nach", "dem Training am See.",
    "Meine Schwester kommt", "etwas später nach.", "Bitte denk an den Schlüssel.", "Das war eine gute Idee.",
    "Am Abend lese ich noch", "ein spannendes Buch.", "Die Kinder spielen draußen", "im Garten hinter dem Haus.",
    "Ruf mich an, wenn du", "morgen etwas Zeit hast.", "Unsere Nachbarn sind nett", "und helfen immer gern.",
]


def measure_size(syn, biases=SIZE_BIASES, seed: int = 7) -> dict | None:
    """The x-height the model really writes at each legibility setting, in the
    writer's x-heights: {"bias": [...], "xh": [...]}.

    The legibility setting (bias) narrows the predicted spread, and that
    shortens every pen step: measured on several models, letters come out 15 to
    25 % smaller at the app's default while the gaps between words keep their
    size, so the writing looks small and widely spaced.  The table lets the
    layout scale the words back (size_scale)."""
    xh_model, ratio = float(syn.meta["xh_model"]), float(syn.meta.get("tall_ratio", 2.6))
    out = []
    for b in biases:
        sizes = []
        for ink in syn.write(SIZE_TEXTS, bias=float(b), seed=seed, tries=1):
            ink.points[:, :2] /= xh_model
            probe = ink.copy(kind="line")
            a, c, _ = prep.baseline(probe)
            x = prep.fit_xheight(prep.letter_heights(probe, a, c), ink.text, ratio)
            if np.isfinite(x) and x > 0:
                sizes.append(float(x))
        if len(sizes) < len(SIZE_TEXTS) // 2:
            return None                          # the model does not write well enough to be measured
        out.append(round(float(np.median(sizes)), 4))
    return {"bias": [float(b) for b in biases], "xh": out}


def size_scale(meta: dict, bias: float) -> float:
    """Factor that brings generated words back to the writer's letter size at
    this legibility setting (1.0 when the model carries no measurement)."""
    table = meta.get("size_by_bias")
    if not table:
        return 1.0
    xh = float(np.interp(bias, table["bias"], table["xh"]))
    return float(np.clip(1.0 / xh, 0.8, 1.5)) if xh > 0 else 1.0


def layout(pieces_by_paragraph: list[list[Ink]], width: float = 84.0, line_height: float = 6.5,
           gap: tuple[float, float] = (2.9, 0.8), margin: float = 3.0, top: float = 5.0,
           seed: int | None = 0, gap_draws=None, scale: float = 1.0) -> Page:
    """Set straightened pieces (xh units) on a page `width` x-heights wide.
    Words of one piece keep the spacing the network gave them; between pieces
    the writer's typical word gap is used.  `gap_draws` (an iterable of standard
    normal numbers, one per piece) makes the result reproducible elsewhere.
    `scale` enlarges every word about its left end on the baseline (see
    size_scale); the gaps are not scaled, the network writes them at full size.
    Every word is set on the line (prep.word_level)."""
    rng = np.random.default_rng(seed)
    draws = iter(gap_draws) if gap_draws is not None else None
    y, lines = top, 1
    right = None                                  # right edge of the last word on this line
    out, placed = [], []
    for k, para in enumerate(pieces_by_paragraph):
        if k > 0:
            y, lines, right = y + line_height, lines + 1, None
        for piece in para:
            prev_end = None                       # right edge of the previous word inside the piece
            for w, level in levelled_words(piece):
                x0, x1 = float(w.points[:, 0].min()), float(w.points[:, 0].max())
                if prev_end is None:
                    z = float(next(draws)) if draws is not None else float(rng.standard_normal())
                    g = float(np.clip(gap[0] + gap[1] * z, 0.6 * gap[0], 1.6 * gap[0]))
                else:
                    g = float(np.clip(x0 - prev_end, 0.5 * gap[0], 1.8 * gap[0]))
                prev_end = x1
                wide = (x1 - x0) * scale
                start = margin if right is None else right + g
                if right is not None and start + wide > width - margin:
                    y, lines, start = y + line_height, lines + 1, margin
                p = w.points.copy()
                p[:, 0] = (p[:, 0] - x0) * scale + start
                p[:, 1] = (p[:, 1] - level) * scale + y
                out.append(p)
                right = start + wide
                placed.append({"text": w.text, "x": start, "y": y, "width": wide, "level": level,
                               "ok": piece.meta.get("ok", True)})
    pts = np.vstack(out) if out else np.zeros((0, 3), dtype=np.float32)
    text = "\n".join(" ".join(p.text for p in para) for para in pieces_by_paragraph)
    return Page(Ink(pts, text=text, kind="line", source="generated"), width, y + 3.5, lines, placed)


def write_page(syn, text: str, width: float = 84.0, line_height: float = 6.5, bias: float = 0.8,
               seed: int | None = None, max_chars: int = MAX_PIECE_CHARS) -> Page:
    clean = "\n".join(syn.charset.normalize(line) for line in text.split("\n"))
    paragraphs = split_pieces(clean, max_chars)
    flat = [p for para in paragraphs for p in para]
    inks = syn.write(flat, bias=bias, seed=seed) if flat else []
    xh = float(syn.meta["xh_model"])
    done, it = [], iter(inks)
    for para in paragraphs:
        row = []
        for _ in para:
            ink = next(it)
            ink.points[:, :2] /= xh
            row.append(straighten(ink))
        done.append(row)
    gap = tuple(syn.meta.get("gap_xh", (2.9, 0.8)))
    return layout(done, width=width, line_height=line_height, gap=gap, seed=seed, scale=size_scale(syn.meta, bias))


def render_page(page: Page, path: str, dpi: int = 110, lw: float = 1.1, color: str = "#1b2a49"):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(page.width / 7.0, page.height / 7.0))
    ax = fig.add_axes([0, 0, 1, 1])
    for s in page.ink.strokes():
        if len(s) == 1:
            ax.plot(s[:, 0], -s[:, 1], ".", color=color, ms=lw * 1.6)
        else:
            ax.plot(s[:, 0], -s[:, 1], "-", color=color, lw=lw, solid_capstyle="round", solid_joinstyle="round")
    ax.set_xlim(0, page.width)
    ax.set_ylim(-page.height, 0)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(path, dpi=dpi, facecolor="#fbfaf7")
    plt.close(fig)

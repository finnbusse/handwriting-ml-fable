"""Lay out longer text as a page of handwriting.

The network writes one short piece at a time (it was trained on word groups of
at most ~27 characters).  A page is built by
  1. splitting the text into such pieces at word boundaries,
  2. writing all pieces,
  3. straightening each piece on its own baseline and
  4. setting the pieces one after another, with the writer's own word spacing,
     wrapping at the page width.

Everything here is in xh units (1.0 = x-height, y down).  The same algorithm
runs in the browser (web/js/generate/layout.js); scripts/make_engine_fixture.py
exports reference results.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import dataset, prep
from .ink import Ink

MAX_PIECE_CHARS = 27


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


def layout(pieces_by_paragraph: list[list[Ink]], width: float = 84.0, line_height: float = 6.5,
           gap: tuple[float, float] = (2.9, 0.8), margin: float = 3.0, top: float = 5.0,
           seed: int | None = 0, gap_draws=None) -> Page:
    """Set straightened pieces (xh units) on a page `width` x-heights wide.
    Words of one piece keep the spacing the network gave them; between pieces
    the writer's typical word gap is used.  `gap_draws` (an iterable of standard
    normal numbers, one per piece) makes the result reproducible elsewhere."""
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
            for w in piece_words(piece):
                x0, x1 = float(w.points[:, 0].min()), float(w.points[:, 0].max())
                if prev_end is None:
                    z = float(next(draws)) if draws is not None else float(rng.standard_normal())
                    g = float(np.clip(gap[0] + gap[1] * z, 0.6 * gap[0], 1.6 * gap[0]))
                else:
                    g = float(np.clip(x0 - prev_end, 0.5 * gap[0], 1.8 * gap[0]))
                prev_end = x1
                start = margin if right is None else right + g
                if right is not None and start + (x1 - x0) > width - margin:
                    y, lines, start = y + line_height, lines + 1, margin
                p = w.points.copy()
                p[:, 0] += start - x0
                p[:, 1] += y
                out.append(p)
                right = start + (x1 - x0)
                placed.append({"text": w.text, "x": start, "y": y, "width": x1 - x0,
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
    return layout(done, width=width, line_height=line_height, gap=gap, seed=seed)


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

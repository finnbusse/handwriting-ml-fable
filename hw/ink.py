"""Ink = pen trajectory.  One array (N, 3): x, y, eos in absolute coordinates,
y pointing down (screen convention), eos = 1 on the last point of each stroke.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Ink:
    points: np.ndarray                     # (N,3) float32: x, y, eos
    text: str = ""
    id: str = ""
    source: str = ""
    kind: str = "word"                     # "word" | "line"
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        self.points = np.asarray(self.points, dtype=np.float32).reshape(-1, 3)
        if len(self.points):
            self.points[-1, 2] = 1.0

    def __len__(self) -> int:
        return len(self.points)

    @property
    def xy(self) -> np.ndarray:
        return self.points[:, :2]

    def strokes(self) -> list[np.ndarray]:
        ends = np.flatnonzero(self.points[:, 2] > 0.5)
        out, start = [], 0
        for e in ends:
            out.append(self.points[start:e + 1, :2])
            start = e + 1
        if start < len(self.points):
            out.append(self.points[start:, :2])
        return out

    def copy(self, **changes) -> "Ink":
        d = dict(points=self.points.copy(), text=self.text, id=self.id, source=self.source,
                 kind=self.kind, meta=dict(self.meta))
        d.update(changes)
        return Ink(**d)

    def bbox(self) -> tuple[float, float, float, float]:
        x, y = self.points[:, 0], self.points[:, 1]
        return float(x.min()), float(y.min()), float(x.max()), float(y.max())


def from_strokes(strokes: list[np.ndarray], **kw) -> Ink:
    parts = []
    for s in strokes:
        s = np.asarray(s, dtype=np.float32)[:, :2]
        if len(s) == 0:
            continue
        eos = np.zeros((len(s), 1), dtype=np.float32)
        eos[-1] = 1.0
        parts.append(np.hstack([s, eos]))
    pts = np.vstack(parts) if parts else np.zeros((0, 3), dtype=np.float32)
    return Ink(pts, **kw)


def to_offsets(points: np.ndarray) -> np.ndarray:
    """Absolute (N,3) -> offsets (N,3); the first offset is (0,0)."""
    off = points.astype(np.float32).copy()
    off[1:, :2] = points[1:, :2] - points[:-1, :2]
    off[0, :2] = 0.0
    return off


def from_offsets(offsets: np.ndarray) -> np.ndarray:
    pts = np.asarray(offsets, dtype=np.float32).copy()
    pts[:, :2] = np.cumsum(pts[:, :2], axis=0)
    return pts


# ------------------------------------------------------------------ rendering
def svg_path(ink: Ink, precision: int = 1) -> str:
    segs = []
    for s in ink.strokes():
        if len(s) == 1:
            x, y = s[0]
            segs.append(f"M{x:.{precision}f},{y:.{precision}f}l0.01,0")
            continue
        segs.append("M" + "L".join(f"{x:.{precision}f},{y:.{precision}f}" for x, y in s))
    return "".join(segs)


def draw(ax, ink: Ink, color="k", lw=1.2, title: str | None = None):
    for s in ink.strokes():
        if len(s) == 1:
            ax.plot(s[:, 0], -s[:, 1], ".", color=color, ms=lw * 1.5)
        else:
            ax.plot(s[:, 0], -s[:, 1], "-", color=color, lw=lw, solid_capstyle="round")
    ax.set_aspect("equal")
    ax.axis("off")
    if title is not None:
        ax.set_title(title, fontsize=8, loc="left")


def contact_sheet(inks: list[Ink], path: str, cols: int = 1, titles: list[str] | None = None,
                  row_height: float = 0.9, width: float = 14.0, colors: list[str] | None = None,
                  dpi: int = 80, lw: float = 1.2):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    rows = int(np.ceil(len(inks) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(width, row_height * rows), squeeze=False)
    for i, ax in enumerate(axes.ravel()):
        if i >= len(inks):
            ax.axis("off")
            continue
        draw(ax, inks[i], color=(colors[i] if colors else "k"), lw=lw,
             title=(titles[i] if titles else inks[i].text))
    fig.tight_layout()
    fig.savefig(path, dpi=dpi)
    plt.close(fig)

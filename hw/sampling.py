"""Text -> ink with a trained network."""
from __future__ import annotations

import json
import os

import numpy as np
import torch

from . import page, prep
from .charset import BASE_CHARSET, Charset
from .ink import Ink, from_offsets
from .model import SynthesisNetwork, alphabet_size_of, load_state

SENTINEL = "  "   # appended to every text so the attention window has somewhere to stop

# A character counts as skipped when its strongest attention stays below
# SKIP_RATIO x the piece's strongest, or below SKIP_WEAK while the window sat on
# it for SKIP_DWELL x the median number of points per letter of the piece (the
# pen kept writing without getting past it).  A weak peak alone is mostly
# harmless: of 186 pieces flagged by "below 0.15" and judged by eye, 49 % were
# fine, 33 % slightly deformed and 18 % (34) really bad.  This rule catches 18
# of the 34 and flags 11 of the other 152.  On first attempts at the pieces of
# scripts/evaluate.py (119, bias 0.4, seeds 100 and 101) it fires on 0.8-1.7 %
# instead of 7.6-14.3 % for a model at step_xh 0.1446, and on 0.8-2.5 % instead
# of 13.4-16.8 % for one at 0.1556.
SKIP_RATIO = 0.10
SKIP_WEAK = 0.15
SKIP_DWELL = 1.8

# Attempts per piece: up to TRIES; a piece whose best attempt by then is sound
# and only lacks dots gets up to TRIES_FOR_DOTS.  Measured: 6 attempts instead
# of 3 cut the delivered pieces that lack a dot from 12.1 % to 7.5 % for 19 %
# more sampling.
TRIES = 3
TRIES_FOR_DOTS = 6


def expected_dots(text: str) -> int:
    """The dots a text calls for: one on every i and j, two on every umlaut."""
    return sum(text.count(c) for c in "ij") + 2 * sum(text.count(c) for c in "äöüÄÖÜ")


def skipped_chars(norm: str, peak: np.ndarray, where: np.ndarray | None) -> list[int]:
    """Indices of the characters of the normalized text `norm` the network
    skipped (see SKIP_RATIO).  peak[u] is the strongest attention character u
    received, where[i] the character the window sat on at point i."""
    n = len(norm)
    peak = np.asarray(peak, dtype=np.float64)[:n]
    if not n or not len(peak) or peak.max() <= 0:
        return []
    ratio = peak / peak.max()
    dwell = np.zeros(n, dtype=np.int64)
    if where is not None and len(where):
        w = np.asarray(where, dtype=np.int64)
        dwell = np.bincount(w[w < n], minlength=n)[:n]
    letters = [u for u, c in enumerate(norm) if c != " "]
    typical = float(np.median(dwell[letters])) if letters else 0.0
    long_stay = (dwell >= SKIP_DWELL * typical) & (dwell > 0)
    return [int(u) for u in np.flatnonzero((ratio < SKIP_RATIO) | ((ratio < SKIP_WEAK) & long_stay))]


class Synthesizer:
    def __init__(self, model: SynthesisNetwork, charset: Charset, mu, std, meta: dict | None = None):
        self.model = model.eval()
        self.charset = charset
        self.mu = np.asarray(mu, dtype=np.float32)
        self.std = np.asarray(std, dtype=np.float32)
        self.meta = meta or {}

    # ------------------------------------------------------------------- I/O
    @classmethod
    def load(cls, model_dir: str) -> "Synthesizer":
        with open(os.path.join(model_dir, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        state = load_state(os.path.join(model_dir, "model.pt"))
        charset = Charset(meta.get("charset", BASE_CHARSET))
        v = alphabet_size_of(state)
        if v != charset.size:
            raise ValueError(f"checkpoint alphabet {v} != charset size {charset.size}")
        model = SynthesisNetwork(v)
        model.load_state_dict(state, strict=True)
        return cls(model, charset, meta["mu"], meta["std"], meta)

    def save(self, model_dir: str, extra_meta: dict | None = None):
        os.makedirs(model_dir, exist_ok=True)
        torch.save(self.model.state_dict(), os.path.join(model_dir, "model.pt"))
        meta = dict(self.meta)
        meta.update(mu=[float(v) for v in self.mu], std=[float(v) for v in self.std],
                    charset=self.charset.chars)
        meta.update(extra_meta or {})
        with open(os.path.join(model_dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)

    # ------------------------------------------------------------ conversion
    def normalize(self, offsets: np.ndarray) -> np.ndarray:
        return ((offsets - self.mu) / self.std).astype(np.float32)

    def denormalize(self, offsets: np.ndarray) -> np.ndarray:
        return (offsets * self.std + self.mu).astype(np.float32)

    def encode(self, texts: list[str], sentinel: str = SENTINEL):
        toks = [self.charset.encode(self.charset.normalize(t) + sentinel) for t in texts]
        lens = torch.tensor([len(t) for t in toks])
        tokens = torch.zeros(len(toks), int(lens.max()), dtype=torch.long)
        for i, t in enumerate(toks):
            tokens[i, : len(t)] = torch.tensor(t)
        return tokens, lens

    # -------------------------------------------------------------- sampling
    def write(self, texts: list[str], bias: float = 0.8, seed: int | None = None,
              max_steps: int | None = None, eos_mode: str = "sample", tries: int | None = None,
              return_attention: bool = False) -> list[Ink]:
        """Write each text once.  Samples that went wrong (did not finish,
        skipped characters, absurd length, drift) or lack dots on i, j, ä, ö, ü
        are written again and the best attempt is kept: a sound one before a
        faulty one, then the one with the fewest missing dots.  A piece stops as
        soon as an attempt is perfect.  By default (the app's policy) a piece
        gets up to TRIES attempts, and up to TRIES_FOR_DOTS if its best attempt
        is sound and only lacks dots; `tries` instead caps every piece at that
        many.  `meta` records how it went.

        Inks come back in model units with the pen start at (0, 0)."""
        base, most = (TRIES, TRIES_FOR_DOTS) if tries is None else (tries, tries)
        gen = torch.Generator().manual_seed(seed) if seed is not None else None
        result: list[Ink | None] = [None] * len(texts)
        todo = list(range(len(texts)))
        for attempt in range(1, most + 1):
            if not todo:
                break
            batch = [texts[i] for i in todo]
            tokens, lens = self.encode(batch)
            steps = max_steps or int(60 * int(lens.max()) + 100)
            seqs, infos = self.model.sample(tokens, lens, bias=bias, max_steps=steps, eos_mode=eos_mode,
                                            n_tail=len(SENTINEL), generator=gen,
                                            return_attention=return_attention)
            again = []
            for i, text, seq, info in zip(todo, batch, seqs, infos):
                ink = self._finish(text, seq.numpy(), info)
                ink.meta["attempt"] = attempt
                self.judge(ink)
                if return_attention:
                    ink.meta["attention"] = info["attention"]
                if result[i] is None or self._rank(ink) < self._rank(result[i]):
                    result[i] = ink
                if self._rank(result[i]) > (False, 0) and (attempt < base or result[i].meta["ok"]):
                    again.append(i)
            todo = again
        return result

    @staticmethod
    def _rank(ink: Ink) -> tuple[bool, int]:
        """Smaller is better: sound before faulty, then fewer missing dots."""
        return (not ink.meta["ok"], ink.meta["missing_dots"])

    def judge(self, ink: Ink) -> Ink:
        """The checks of a written piece that need its baseline (ink in model
        units, as _finish returns it):
          missing_dots  dots the text calls for but the ink does not show
          drift         the pen slid below the line on letters without a descender
                        (added to `problems`, the piece is then not `ok`)"""
        norm = self.charset.normalize(ink.text)
        p = ink.points.copy()
        p[:, :2] /= float(self.meta.get("xh_model", 100.0))
        probe = Ink(p, text=norm, kind="line", source="generated")
        want = expected_dots(norm)
        ink.meta["missing_dots"] = max(want - prep.dot_strokes(probe), 0) if want and len(p) else want
        where = ink.meta.pop("where", None)
        if where is not None and len(p):
            depth = page.stray_depth(page.straighten(probe), where)
            ink.meta["stray_depth"] = round(depth, 3)
            if depth > prep.MAX_PLAIN_DEPTH:
                ink.meta["problems"].append(f"drift {depth:.1f}")
                ink.meta["ok"] = False
        return ink

    def _finish(self, text: str, seq: np.ndarray, info: dict) -> Ink:
        pts = from_offsets(self.denormalize(seq))
        n_real = len(self.charset.normalize(text))
        peak = info["char_peak"].numpy()[:n_real]
        # 1. cut what was written after the text was done: once the window sits on
        #    the sentinel, the network jumps on as if another word followed
        tail, cut = info["tail_step"], len(pts)
        if tail > 0:
            body_right = float(pts[:tail, 0].max())
            margin = 0.6 * float(self.meta.get("xh_model", 100.0))
            ends = np.flatnonzero(pts[:, 2] > 0.5)
            starts = np.concatenate([[0], ends[:-1] + 1])
            for s, e in zip(starts[::-1], ends[::-1]):
                if s >= tail and float(pts[s:e + 1, 0].min()) > body_right + margin:
                    cut = s
                else:
                    break
        pts = pts[:max(cut, 1)]
        # 2. judge the sample
        letters = max(len(text.replace(" ", "")), 1)
        ppc = len(pts) / letters
        where = np.asarray(info["where"])[:len(pts)] if "where" in info else None
        skipped = len(skipped_chars(self.charset.normalize(text), peak, where))
        problems = []
        if not info["finished"]:
            problems.append("unfinished")
        if skipped:
            problems.append(f"skipped {skipped}")
        if not 8 <= ppc <= 70:
            problems.append(f"points/char {ppc:.0f}")
        meta = {"finished": info["finished"], "ok": not problems, "problems": problems}
        if where is not None:                              # for judge(): which character each point belongs to
            meta["where"] = where
        return Ink(pts, text=text, kind="line", source="generated", meta=meta)

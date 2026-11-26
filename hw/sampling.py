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


def expected_dots(text: str) -> int:
    """The dots a text calls for: one on every i and j, two on every umlaut."""
    return sum(text.count(c) for c in "ij") + 2 * sum(text.count(c) for c in "äöüÄÖÜ")


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
              max_steps: int | None = None, eos_mode: str = "sample", tries: int = 3,
              return_attention: bool = False) -> list[Ink]:
        """Write each text once.  Samples that went wrong (did not finish,
        skipped characters, absurd length) or lack dots on i, j, ä, ö, ü are
        written again, up to `tries` times, and the best attempt is kept: a
        sound one before a faulty one, then the one with the fewest missing
        dots.  `meta` records how it went.

        Inks come back in model units with the pen start at (0, 0)."""
        gen = torch.Generator().manual_seed(seed) if seed is not None else None
        result: list[Ink | None] = [None] * len(texts)
        todo = list(range(len(texts)))
        for attempt in range(1, tries + 1):
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
                if self._rank(result[i]) > (False, 0):
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
        skipped = int((peak < 0.15 * float(peak.max())).sum()) if len(peak) else 0
        problems = []
        if not info["finished"]:
            problems.append("unfinished")
        if skipped:
            problems.append(f"skipped {skipped}")
        if not 8 <= ppc <= 70:
            problems.append(f"points/char {ppc:.0f}")
        meta = {"finished": info["finished"], "ok": not problems, "problems": problems}
        if "where" in info:                                # for judge(): which character each point belongs to
            meta["where"] = np.asarray(info["where"])[:len(pts)]
        return Ink(pts, text=text, kind="line", source="generated", meta=meta)

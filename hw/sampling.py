"""Text -> ink with a trained network."""
from __future__ import annotations

import json
import os

import numpy as np
import torch

from .charset import BASE_CHARSET, Charset
from .ink import Ink, from_offsets
from .model import SynthesisNetwork, alphabet_size_of, load_state

SENTINEL = "  "   # appended to every text so the attention window has somewhere to stop


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
    def write(self, texts: list[str], bias: float = 1.0, seed: int | None = None,
              max_steps: int | None = None, eos_mode: str = "threshold",
              return_attention: bool = False):
        tokens, lens = self.encode(texts)
        gen = None
        if seed is not None:
            gen = torch.Generator().manual_seed(seed)
        if max_steps is None:
            max_steps = int(60 * int(lens.max()) + 100)
        res = self.model.sample(tokens, lens, bias=bias, max_steps=max_steps, eos_mode=eos_mode,
                                generator=gen, return_attention=return_attention)
        seqs, atts = res if return_attention else (res, None)
        inks = []
        for text, seq in zip(texts, seqs):
            pts = from_offsets(self.denormalize(seq.numpy()))
            inks.append(Ink(pts, text=text, kind="line", source="generated",
                            meta={"finished": bool(len(seq) < max_steps)}))
        if return_attention:
            return inks, atts
        return inks

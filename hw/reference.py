"""Reference implementation of text -> strokes, written for clarity.

This is the *normative* algorithm for the browser engine (web/js/engine): one
sequence, explicit random draws, no batching tricks.  hw.model.sample does the
same thing in batches for training-time use; scripts/make_engine_fixture.py
records this function's inputs and outputs so the JavaScript port can be
checked number by number.

Per step t, given the previous point x (zeros at t = 0) and four random draws
(u_comp, n1, n2, u_eos):

    h1          = lstm1([x, w])                       w = last window vector (zeros at t = 0)
    alpha,beta  = exp(linear(h1));  kappa += exp(linear(h1))
    phi[u]      = sum_k alpha_k * exp(-beta_k * (kappa_k - u)^2)      u = 0..U-1
    w           = sum_u phi[u] * onehot(text[u])
    h2          = lstm2([x, h1, w]);   h3 = lstm3([x, h2, w])
    y           = mixture([h1, h2, h3])
    pi          = softmax(y.pi * (1 + bias))
    j           = first index with cumsum(pi)[j] > u_comp   (last index if none)
    dx          = mu1_j + exp(logsd1_j - bias) * n1
    dy          = mu2_j + exp(logsd2_j - bias) * (rho_j * n1 + sqrt(1 - rho_j^2) * n2)
    eos         = 1 if u_eos < sigmoid(y.eos) else 0
    stop        if t >= MIN_STEPS_PER_CHAR * (U - n_tail)
                and (phi[U-1] > 0.8  or  (argmax(phi) == U-1 and eos == 1))   -> eos := 1

The text passed in already ends with the sentinel (two spaces).  `tail_step`
is the first step at which argmax(phi) lies on the sentinel.
"""
from __future__ import annotations

import numpy as np
import torch

from .model import MIN_STEPS_PER_CHAR, SynthesisNetwork


@torch.no_grad()
def sample_reference(model: SynthesisNetwork, tokens: list[int], draws: np.ndarray, bias: float,
                     n_tail: int, max_steps: int | None = None, trace: int = 0) -> dict:
    """draws: (N,4) array of u_comp, n1, n2, u_eos.  Returns offsets in
    normalised units plus the bookkeeping the post-processing needs.  With
    `trace` > 0 the internal quantities of the first `trace` steps are returned
    too (for debugging a port)."""
    U = len(tokens)
    tk = torch.tensor([tokens])
    onehot = model.onehot(tk, torch.tensor([U]))
    u = torch.arange(U, dtype=torch.float32)
    state = model.initial_state(1)
    x = torch.zeros(1, 3)
    n_steps = min(len(draws), max_steps or len(draws))
    min_steps = MIN_STEPS_PER_CHAR * max(U - n_tail, 0)
    out, peak, tail_step, finished, traced, wheres = [], np.zeros(U, dtype=np.float32), -1, False, [], []
    for t in range(n_steps):
        u_comp, n1, n2, u_eos = (float(v) for v in draws[t])
        h, phi, state = model.step(x, onehot, u, state)
        p = model.mixture(h)
        pi = torch.softmax(p.pi_logit[0] * (1.0 + bias), dim=-1).numpy()
        cum = np.cumsum(pi.astype(np.float64))
        j = int(np.searchsorted(cum, u_comp, side="right"))
        j = min(j, len(pi) - 1)
        mu1, mu2 = float(p.mu1[0, j]), float(p.mu2[0, j])
        sd1 = float(np.exp(float(p.log_sd1[0, j]) - bias))
        sd2 = float(np.exp(float(p.log_sd2[0, j]) - bias))
        rho = float(p.rho[0, j])
        dx = mu1 + sd1 * n1
        dy = mu2 + sd2 * (rho * n1 + float(np.sqrt(max(1.0 - rho * rho, 0.0))) * n2)
        p_eos = float(torch.sigmoid(p.eos_logit[0]))
        eos = 1.0 if u_eos < p_eos else 0.0
        ph = phi[0].numpy()
        where = int(ph.argmax())
        done = t >= min_steps and bool(ph[U - 1] > 0.8 or (where == U - 1 and eos > 0.5))
        if done:
            eos = 1.0
        peak = np.maximum(peak, ph)
        if n_tail > 0 and tail_step < 0 and where >= U - n_tail:
            tail_step = t
        out.append((dx, dy, eos))
        wheres.append(where)
        if t < trace:
            traced.append({"phi": ph.tolist(), "kappa": state[6][0].tolist(), "pi": pi.tolist(),
                           "mu1": p.mu1[0].tolist(), "mu2": p.mu2[0].tolist(),
                           "log_sd1": p.log_sd1[0].tolist(), "log_sd2": p.log_sd2[0].tolist(),
                           "rho": p.rho[0].tolist(), "p_eos": p_eos, "component": j,
                           "h1_head": state[0][0, :8].tolist(), "h3_head": state[4][0, :8].tolist()})
        x = torch.tensor([[dx, dy, eos]], dtype=torch.float32)
        if done:
            finished = True
            break
    return {"offsets": np.array(out, dtype=np.float32), "finished": finished, "tail_step": tail_step,
            "char_peak": peak, "where": np.array(wheres, dtype=np.int64), "trace": traced}


def make_draws(n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    d = np.empty((n, 4), dtype=np.float64)
    d[:, 0] = rng.random(n)
    d[:, 1] = rng.standard_normal(n)
    d[:, 2] = rng.standard_normal(n)
    d[:, 3] = rng.random(n)
    return d

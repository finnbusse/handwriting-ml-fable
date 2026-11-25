"""Handwriting synthesis network (Graves 2013, "Generating Sequences With RNNs").

Three peephole-LSTM layers, a soft attention window over the one-hot text and
a mixture-density output layer.  Parameter names and shapes match the MIT
licensed checkpoints of X-rayLaser/pytorch-handwriting-synthesis-toolkit, so
those weights load directly; the implementation itself is written from scratch
(single fused time loop, log-domain loss, batched sampling).

Conventions
-----------
A stroke sequence is a float tensor (T, 3): dx, dy, eos.  dx/dy are offsets to
the previous point in *normalized* units (see hw.norm), eos is 1 on the last
point of every stroke (the pen lifts after it).  The network input at step t is
point t-1 (zeros for t=0) and it predicts the distribution of point t.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

HIDDEN = 400
WINDOW_K = 10
MIXTURES = 20


class PeepholeLSTMCell(nn.Module):
    def __init__(self, input_size: int, hidden_size: int):
        super().__init__()
        self.hidden_size = hidden_size
        self.W_ci = nn.Parameter(torch.empty(hidden_size))
        self.b_i = nn.Parameter(torch.empty(hidden_size))
        self.W_cf = nn.Parameter(torch.empty(hidden_size))
        self.b_f = nn.Parameter(torch.empty(hidden_size))
        self.b_c = nn.Parameter(torch.empty(hidden_size))
        self.W_co = nn.Parameter(torch.empty(hidden_size))
        self.b_o = nn.Parameter(torch.empty(hidden_size))
        self.W_xh = nn.Parameter(torch.empty(input_size + hidden_size, hidden_size * 4))
        sd = 1.0 / math.sqrt(hidden_size)
        for p in self.parameters():
            nn.init.uniform_(p, -sd, sd)

    def forward(self, x: Tensor, h: Tensor, c: Tensor) -> tuple[Tensor, Tensor]:
        z = torch.cat([x, h], dim=1) @ self.W_xh
        z_i, z_f, z_c, z_o = z.chunk(4, dim=1)
        i = torch.sigmoid(z_i + c * self.W_ci + self.b_i)
        f = torch.sigmoid(z_f + c * self.W_cf + self.b_f)
        c = f * c + i * torch.tanh(z_c + self.b_c)
        o = torch.sigmoid(z_o + c * self.W_co + self.b_o)
        return o * torch.tanh(c), c


class SoftWindow(nn.Module):
    def __init__(self, hidden_size: int, components: int):
        super().__init__()
        self.alpha = nn.Linear(hidden_size, components)
        self.beta = nn.Linear(hidden_size, components)
        self.k = nn.Linear(hidden_size, components)

    def forward(self, h: Tensor, kappa: Tensor, u: Tensor) -> tuple[Tensor, Tensor]:
        """h (B,H), kappa (B,K), u (U,) -> phi (B,U), new kappa (B,K)."""
        alpha = torch.exp(self.alpha(h)).unsqueeze(2)
        beta = torch.exp(self.beta(h)).unsqueeze(2)
        kappa = kappa + torch.exp(self.k(h))
        phi = (alpha * torch.exp(-beta * (kappa.unsqueeze(2) - u) ** 2)).sum(dim=1)
        return phi, kappa


class MixtureHead(nn.Module):
    def __init__(self, input_size: int, components: int):
        super().__init__()
        self.pi = nn.Linear(input_size, components)
        self.mu = nn.Linear(input_size, components * 2)
        self.sd = nn.Linear(input_size, components * 2)
        self.ro = nn.Linear(input_size, components)
        self.eos = nn.Linear(input_size, 1)

    def forward(self, h: Tensor) -> "MixtureParams":
        m = self.pi.out_features
        mu = self.mu(h)
        log_sd = self.sd(h)
        return MixtureParams(
            pi_logit=self.pi(h),
            mu1=mu[..., :m], mu2=mu[..., m:],
            log_sd1=log_sd[..., :m], log_sd2=log_sd[..., m:],
            rho=torch.tanh(self.ro(h)),
            eos_logit=self.eos(h).squeeze(-1),
        )


@dataclass
class MixtureParams:
    pi_logit: Tensor
    mu1: Tensor
    mu2: Tensor
    log_sd1: Tensor
    log_sd2: Tensor
    rho: Tensor
    eos_logit: Tensor

    def log_prob(self, target: Tensor) -> Tensor:
        """Log-likelihood of target points (..., 3); returns shape (...)."""
        x1 = target[..., 0:1]
        x2 = target[..., 1:2]
        eos = target[..., 2]
        z1 = (x1 - self.mu1) * torch.exp(-self.log_sd1)
        z2 = (x2 - self.mu2) * torch.exp(-self.log_sd2)
        one_m_rho2 = (1.0 - self.rho ** 2).clamp_min(1e-6)
        quad = (z1 ** 2 + z2 ** 2 - 2.0 * self.rho * z1 * z2) / (2.0 * one_m_rho2)
        log_n = -quad - math.log(2.0 * math.pi) - self.log_sd1 - self.log_sd2 - 0.5 * torch.log(one_m_rho2)
        log_mix = torch.logsumexp(F.log_softmax(self.pi_logit, dim=-1) + log_n, dim=-1)
        log_eos = -F.binary_cross_entropy_with_logits(self.eos_logit, eos, reduction="none")
        return log_mix + log_eos


class SynthesisNetwork(nn.Module):
    def __init__(self, alphabet_size: int, hidden_size: int = HIDDEN,
                 window_components: int = WINDOW_K, mixtures: int = MIXTURES):
        super().__init__()
        self.alphabet_size = alphabet_size
        self.hidden_size = hidden_size
        self.window_components = window_components
        self.mixtures = mixtures
        self.lstm1 = PeepholeLSTMCell(3 + alphabet_size, hidden_size)
        self.window = SoftWindow(hidden_size, window_components)
        self.lstm2 = PeepholeLSTMCell(3 + hidden_size + alphabet_size, hidden_size)
        self.lstm3 = PeepholeLSTMCell(3 + hidden_size + alphabet_size, hidden_size)
        self.mixture = MixtureHead(hidden_size * 3, mixtures)

    # ------------------------------------------------------------------ state
    def initial_state(self, batch: int, device=None) -> list[Tensor]:
        """[h1,c1,h2,c2,h3,c3,kappa,w]"""
        z = lambda n: torch.zeros(batch, n, device=device)
        H = self.hidden_size
        return [z(H), z(H), z(H), z(H), z(H), z(H), z(self.window_components), z(self.alphabet_size)]

    def step(self, x: Tensor, onehot: Tensor, u: Tensor, state: list[Tensor]):
        """One time step.  x (B,3), onehot (B,U,V) with all-zero rows as padding.
        Returns concatenated hidden (B,3H), attention phi (B,U), new state."""
        h1, c1, h2, c2, h3, c3, kappa, w = state
        h1, c1 = self.lstm1(torch.cat([x, w], dim=1), h1, c1)
        phi, kappa = self.window(h1, kappa, u)
        w = torch.bmm(phi.unsqueeze(1), onehot).squeeze(1)
        h2, c2 = self.lstm2(torch.cat([x, h1, w], dim=1), h2, c2)
        h3, c3 = self.lstm3(torch.cat([x, h2, w], dim=1), h3, c3)
        return torch.cat([h1, h2, h3], dim=1), phi, [h1, c1, h2, c2, h3, c3, kappa, w]

    def onehot(self, tokens: Tensor, text_len: Tensor) -> Tensor:
        """tokens (B,U) long, text_len (B,) -> (B,U,V) float with zero padding rows."""
        oh = F.one_hot(tokens, self.alphabet_size).float()
        mask = torch.arange(tokens.shape[1], device=tokens.device)[None, :] < text_len[:, None]
        return oh * mask.unsqueeze(-1)

    # --------------------------------------------------------------- training
    def forward(self, points: Tensor, tokens: Tensor, text_len: Tensor,
                return_attention: bool = False):
        """Teacher-forced pass.  points (B,T,3) are the *targets*; inputs are the
        same sequence shifted right by one.  Returns MixtureParams over (B,T)."""
        B, T, _ = points.shape
        onehot = self.onehot(tokens, text_len)
        u = torch.arange(tokens.shape[1], device=points.device, dtype=points.dtype)
        inputs = torch.cat([points.new_zeros(B, 1, 3), points[:, :-1]], dim=1)
        state = self.initial_state(B, points.device)
        hs, phis = [], []
        for t in range(T):
            h, phi, state = self.step(inputs[:, t], onehot, u, state)
            hs.append(h)
            if return_attention:
                phis.append(phi)
        params = self.mixture(torch.stack(hs, dim=1))
        if return_attention:
            return params, torch.stack(phis, dim=1)
        return params

    def nll(self, points: Tensor, lengths: Tensor, tokens: Tensor, text_len: Tensor) -> Tensor:
        """Negative log-likelihood per sequence, shape (B,), in nats."""
        params = self.forward(points, tokens, text_len)
        lp = params.log_prob(points)
        mask = torch.arange(points.shape[1], device=points.device)[None, :] < lengths[:, None]
        return -(lp * mask).sum(dim=1)

    # --------------------------------------------------------------- sampling
    @torch.no_grad()
    def sample(self, tokens: Tensor, text_len: Tensor, *, bias: float = 0.0,
               max_steps: int = 1500, eos_mode: str = "sample", n_tail: int = 0,
               prime: Tensor | None = None, prime_len: Tensor | None = None,
               generator: torch.Generator | None = None, return_attention: bool = False):
        """Batched ancestral sampling.

        tokens (B,U) must already include the `n_tail` sentinel characters that
        hw.sampling appends to every text; text_len counts them.  If `prime`
        (B,P,3) is given, those points are fed first (teacher forced) and the
        text must be the priming text followed by the text to write.

        Pen lifts are drawn from the predicted probability (`eos_mode="sample"`,
        as in Graves' paper).  Thresholding at 0.5 instead looks tidier in
        theory but fails in practice: the network is rarely more than 50 % sure
        of the exact step at which a stroke ends, so the pen would stay down
        and the writing would run off into waves.

        Returns (seqs, infos): seqs[i] is a (T_i,3) tensor in normalized units;
        infos[i] has
          finished    the stop rule fired before max_steps
          tail_step   first step at which the attention reached the sentinel
                      (-1 if it never did); points from there on are suspect
          char_peak   (U_i,) strongest attention each character received
          attention   (T_i,U_i), only with return_attention
        """
        device = tokens.device
        B, U = tokens.shape
        onehot = self.onehot(tokens, text_len)
        u = torch.arange(U, device=device, dtype=torch.float32)
        state = self.initial_state(B, device)
        x = torch.zeros(B, 3, device=device)

        if prime is not None:
            P = prime.shape[1]
            for t in range(P):
                active = (t < prime_len).float().unsqueeze(1)
                _, _, new_state = self.step(x, onehot, u, state)
                state = [active * n + (1 - active) * s for n, s in zip(new_state, state)]
                x = active * prime[:, t] + (1 - active) * x

        out = torch.zeros(B, max_steps, 3, device=device)
        att = torch.zeros(B, max_steps, U, device=device) if return_attention else None
        done = torch.zeros(B, dtype=torch.bool, device=device)
        n_pts = torch.zeros(B, dtype=torch.long, device=device)
        tail_step = torch.full((B,), -1, dtype=torch.long, device=device)
        peak = torch.zeros(B, U, device=device)
        last_idx = (text_len - 1).clamp_min(0)
        tail_start = (text_len - n_tail).clamp_min(0)
        ar = torch.arange(B, device=device)

        for t in range(max_steps):
            h, phi, state = self.step(x, onehot, u, state)
            p = self.mixture(h)
            pi = F.softmax(p.pi_logit * (1.0 + bias), dim=-1)
            comp = torch.multinomial(pi, 1, generator=generator).squeeze(1)
            mu1, mu2 = p.mu1[ar, comp], p.mu2[ar, comp]
            sd1 = torch.exp(p.log_sd1[ar, comp] - bias)
            sd2 = torch.exp(p.log_sd2[ar, comp] - bias)
            rho = p.rho[ar, comp]
            n1 = torch.randn(B, device=device, generator=generator)
            n2 = torch.randn(B, device=device, generator=generator)
            dx = mu1 + sd1 * n1
            dy = mu2 + sd2 * (rho * n1 + torch.sqrt((1 - rho ** 2).clamp_min(0)) * n2)
            p_eos = torch.sigmoid(p.eos_logit)
            if eos_mode == "threshold":
                eos = (p_eos > 0.5).float()
            else:
                eos = (torch.rand(B, device=device, generator=generator) < p_eos).float()

            # stop once the window has moved onto the last sentinel and the pen lifts
            where = phi.argmax(dim=1)
            finished = (phi[ar, last_idx] > 0.8) | ((where == last_idx) & (eos > 0.5))
            eos = torch.where(finished, torch.ones_like(eos), eos)

            x = torch.stack([dx, dy, eos], dim=1)
            keep = ~done
            out[keep, t] = x[keep]
            if att is not None:
                att[keep, t] = phi[keep]
            peak[keep] = torch.maximum(peak[keep], phi[keep])
            in_tail = keep & (n_tail > 0) & (where >= tail_start) & (tail_step < 0)
            tail_step[in_tail] = t
            n_pts[keep] += 1
            done = done | finished
            if bool(done.all()):
                break

        seqs, infos = [], []
        for i in range(B):
            n, ul = int(n_pts[i]), int(text_len[i])
            seqs.append(out[i, :n].clone())
            info = {"finished": bool(done[i]), "tail_step": int(tail_step[i]), "char_peak": peak[i, :ul].clone()}
            if att is not None:
                info["attention"] = att[i, :n, :ul].clone()
            infos.append(info)
        return seqs, infos


# ---------------------------------------------------------------- weights I/O
def load_state(path: str) -> dict[str, Tensor]:
    return torch.load(path, map_location="cpu", weights_only=True)


def alphabet_size_of(state: dict[str, Tensor], hidden_size: int = HIDDEN) -> int:
    return state["lstm1.W_xh"].shape[0] - 3 - hidden_size


def extend_alphabet(state: dict[str, Tensor], old_chars: str, new_chars: str,
                    init_from: dict[str, str], hidden_size: int = HIDDEN) -> dict[str, Tensor]:
    """Return a state dict for the larger alphabet `new_chars` (which must start
    with `old_chars`).  The rows that read the one-hot text window are copied
    from a similar-looking character so that e.g. 'ä' starts out as 'a'."""
    if not new_chars.startswith(old_chars):
        raise ValueError("new charset must extend the old one")
    v_old, v_new = len(old_chars) + 1, len(new_chars) + 1
    if v_new == v_old:
        return dict(state)
    # where the V window rows sit inside each W_xh: after x (3) for lstm1,
    # after x and the lower layer's hidden state for lstm2/3.
    offsets = {"lstm1.W_xh": 3, "lstm2.W_xh": 3 + hidden_size, "lstm3.W_xh": 3 + hidden_size}
    out = dict(state)
    for name, off in offsets.items():
        W = state[name]
        assert W.shape[0] in (3 + v_old + hidden_size, 3 + hidden_size + v_old + hidden_size), name
        rows = []
        for ch in new_chars[len(old_chars):]:
            src = init_from.get(ch)
            idx = old_chars.index(src) + 1 if src and src in old_chars else 0
            rows.append(W[off + idx].clone())
        out[name] = torch.cat([W[: off + v_old], torch.stack(rows), W[off + v_old:]], dim=0)
    return out

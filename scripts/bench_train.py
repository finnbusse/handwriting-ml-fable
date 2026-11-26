"""How long would a training take on this machine?

    python scripts/bench_train.py

Runs a few training steps of the real network on made-up data shaped like a
training batch (12 pieces of about 25 characters, up to 700 points) and
projects the time of a whole run.  It needs neither the recordings nor a token,
so it answers in a minute whether a machine -- a free GPU notebook, say -- is
worth using instead of the free GitHub runners (4 CPU cores, about 5.5 minutes
per round of 80 batches).

The network writes point by point and looks at the text again before every
point, so a round is 80 x 700 small steps one after the other: a GPU cannot
run them side by side and gains far less here than on image or text models.
"""
import argparse
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # the repo root, for "hw"

from hw.charset import DEFAULT_CHARSET  # noqa: E402
from hw.model import SynthesisNetwork  # noqa: E402

BATCHES_PER_ROUND = 80          # hw.train: 960 pieces per round in batches of 12
GITHUB_ROUND_S = 330            # measured on the free runners (history.json of the experiment runs)


def one_device(device: torch.device, batch: int, points: int, chars: int, steps: int) -> float:
    """Seconds per training step (forward, backward, update) on `device`."""
    g = torch.Generator().manual_seed(0)
    model = SynthesisNetwork(len(DEFAULT_CHARSET) + 1).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=2e-4)
    x = torch.randn(batch, points, 3, generator=g) * 0.5
    x[..., 2] = (torch.rand(batch, points, generator=g) < 0.04).float()
    tokens = torch.randint(1, len(DEFAULT_CHARSET), (batch, chars), generator=g)
    lengths = torch.full((batch,), chars)
    x, tokens, lengths = x.to(device), tokens.to(device), lengths.to(device)

    def step():
        loss = -model.forward(x, tokens, lengths).log_prob(x).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
        if device.type == "cuda":
            torch.cuda.synchronize()

    step()                                              # the first step pays for start-up
    t = time.time()
    for _ in range(steps):
        step()
    return (time.time() - t) / steps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rounds", type=int, default=20, help="rounds of a whole training")
    ap.add_argument("--steps", type=int, default=5)
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--points", type=int, default=650)
    ap.add_argument("--chars", type=int, default=26)
    ap.add_argument("--skip-cpu", action="store_true")
    args = ap.parse_args()

    devices = ([torch.device("cuda")] if torch.cuda.is_available() else []) + ([] if args.skip_cpu else [torch.device("cpu")])
    github_min = args.rounds * GITHUB_ROUND_S / 60
    print(f"GitHub (4 CPU cores): about {GITHUB_ROUND_S / BATCHES_PER_ROUND:.1f} s per batch, "
          f"{github_min:.0f} min for {args.rounds} rounds")
    for device in devices:
        name = torch.cuda.get_device_name(0) if device.type == "cuda" else f"CPU, {torch.get_num_threads()} threads"
        s = one_device(device, args.batch, args.points, args.chars, args.steps)
        total = args.rounds * BATCHES_PER_ROUND * s / 60
        print(f"{name}: {s:.2f} s per batch, {total:.0f} min for {args.rounds} rounds "
              f"({github_min / total:.1f} x GitHub)", flush=True)
    if not torch.cuda.is_available():
        print("no GPU found (in Colab: Laufzeit -> Laufzeittyp ändern -> T4 GPU)")


if __name__ == "__main__":
    main()

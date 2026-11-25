"""Fine-tune the pretrained synthesis network on one writer.

    python -m hw.train --out runs/v1

What makes this work with little data
  * the pretrained network already knows how to write; we only teach it a hand
  * all recordings are size-normalised and resampled to look like its
    pretraining data (hw.dataset.calibrate)
  * single words are laid out as lines on the fly, freshly combined every
    epoch, so the network sees spaces and never the same line twice
  * real recorded lines are mixed in with their true spacing
  * the alphabet is extended (umlauts, sharp s ...) without disturbing the
    known characters
  * a held-out part decides when to stop
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import time

import numpy as np
import torch

from . import dataset, sources
from .base import ensure_base
from .charset import BASE_CHARSET, DEFAULT_CHARSET, EXTRA_CHARS, Charset
from .ink import Ink, contact_sheet
from .model import SynthesisNetwork, extend_alphabet, load_state
from .sampling import Synthesizer

SAMPLE_TEXTS = [
    "Heute ist ein schöner Tag",
    "Viele Grüße aus Detmold",
    "Fünf Äpfel und zwölf Nüsse",
    "Das Wetter wird morgen besser",
    "Treffen um 14:30 Uhr am Bahnhof",
    "The quick brown fox jumps",
]


# ----------------------------------------------------------------------- data
class Corpus:
    def __init__(self, inks: list[Ink], report: dict, charset: Charset, mu, std, seed: int = 0,
                 max_points: int = dataset.MAX_POINTS, long_points: int = 1250, special_share: float = 0.3):
        self.charset, self.mu, self.std = charset, mu, std
        self.xh_model = report["xh_model"]
        self.max_points, self.long_points = max_points, long_points
        self.rng = np.random.default_rng(seed)
        train, val = dataset.split(inks)
        tw = [i for i in train if i.kind == "word"]
        vw = [i for i in val if i.kind == "word"]
        tl = [i for i in train if i.kind == "line"]
        vl = [i for i in val if i.kind == "line"]
        gap_mean, gap_sd = dataset.measure_gaps(tl + vl)
        self.gap = (gap_mean, gap_sd)
        new_chars = charset.chars[len(BASE_CHARSET):]
        self.composer = dataset.LineComposer(tw, gap_mean, gap_sd, max_points=max_points, seed=seed,
                                             special_chars=new_chars, special_share=special_share)
        self.train_real = self._real(tl)
        self.val_real = self._real(vl)
        self.val_lines = vl
        self.val_composed = dataset.LineComposer(vw, gap_mean, gap_sd, max_points=max_points).fixed(160)
        self.counts = dict(train_words=len(tw), val_words=len(vw), train_lines=len(tl), val_lines=len(vl),
                           train_real_pieces=len(self.train_real), val_real_pieces=len(self.val_real))

    def _real(self, lines: list[Ink]) -> list[Ink]:
        out = []
        for l in lines:
            pieces = dataset.line_chunks(l, self.max_points)
            if len(pieces) == 1 and pieces[0].id == l.id and len(l) > self.max_points:
                pieces = [l] if len(l) <= self.long_points else []
            if not pieces and len(l) <= self.long_points:
                pieces = [l]
            out.extend(pieces)
        return out

    def encode(self, ink: Ink, augment: bool, limit: int | None = None):
        pts = dataset.augment(ink.points, self.rng) if augment else ink.points
        seq = dataset.to_model(ink.copy(points=pts), self.xh_model, self.mu, self.std,
                               max_points=limit or max(self.max_points, len(ink)))
        toks = self.charset.encode(self.charset.normalize(ink.text))
        return seq, toks

    def epoch(self, n_composed: int, real_repeat: int):
        items = [self.encode(self.composer.sample(), True) for _ in range(n_composed)]
        for _ in range(real_repeat):
            items += [self.encode(i, True) for i in self.train_real]
        return items

    def validation(self):
        return ([self.encode(i, False) for i in self.val_real],
                [self.encode(i, False) for i in self.val_composed])


def batches(items, batch_size: int, rng=None, bucket: int = 8):
    """Group sequences of similar length; yields padded tensors."""
    order = np.arange(len(items))
    if rng is not None:
        rng.shuffle(order)
        chunks = [order[i:i + batch_size * bucket] for i in range(0, len(order), batch_size * bucket)]
        order = np.concatenate([c[np.argsort([len(items[j][0]) for j in c])] for c in chunks])
    else:
        order = order[np.argsort([len(items[j][0]) for j in order])]
    groups = [order[i:i + batch_size] for i in range(0, len(order), batch_size)]
    if rng is not None:
        rng.shuffle(groups)
    for g in groups:
        seqs = [items[j][0] for j in g]
        toks = [items[j][1] for j in g]
        T, U = max(len(s) for s in seqs), max(len(t) for t in toks)
        x = torch.zeros(len(g), T, 3)
        tk = torch.zeros(len(g), U, dtype=torch.long)
        for b, (s, t) in enumerate(zip(seqs, toks)):
            x[b, : len(s)] = torch.from_numpy(s)
            tk[b, : len(t)] = torch.tensor(t)
        yield (x, torch.tensor([len(s) for s in seqs]), tk, torch.tensor([len(t) for t in toks]))


@torch.no_grad()
def evaluate(model, items, batch_size: int = 48) -> float:
    """Mean negative log-likelihood per point (nats)."""
    if not items:
        return float("nan")
    model.eval()
    total, n = 0.0, 0
    for x, xl, tk, tl in batches(items, batch_size):
        total += float(model.nll(x, xl, tk, tl).sum())
        n += int(xl.sum())
    return total / max(n, 1)


# ---------------------------------------------------------------------- setup
def build_model(base_dir: str, charset: Charset):
    with open(os.path.join(base_dir, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    state = load_state(os.path.join(base_dir, "model.pt"))
    old_chars = meta.get("charset", BASE_CHARSET)
    if not charset.chars.startswith(old_chars):
        raise ValueError("charset must extend the checkpoint's charset")
    state = extend_alphabet(state, old_chars, charset.chars, EXTRA_CHARS)
    model = SynthesisNetwork(charset.size)
    model.load_state_dict(state)
    return model, meta


def load_corpus_inks(cache: str, base_stats: dict, token: str | None, fetch: bool,
                     extra_sources: dict | None = None):
    raw = sources.load_all(cache, token=token, fetch=fetch, extra=extra_sources)
    raw, excluded = dataset.apply_exclusions(raw, dataset.load_exclusions())
    inks, report = dataset.calibrate_cached(raw, base_stats, cache)
    report["excluded"] = excluded
    return inks, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="runs/v1")
    ap.add_argument("--base", default="artifacts/base", help="directory with model.pt, meta.json, stats.json")
    ap.add_argument("--init", default=None, help="continue from this checkpoint directory instead of the base")
    ap.add_argument("--cache", default="data_cache")
    ap.add_argument("--no-fetch", action="store_true", help="use the local data cache only")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--composed", type=int, default=480, help="composed lines per epoch")
    ap.add_argument("--real-repeat", type=int, default=4, help="passes over the real lines per epoch")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lr-final", type=float, default=2e-5)
    ap.add_argument("--clip", type=float, default=5.0)
    ap.add_argument("--new-char-boost", type=float, default=20.0,
                    help="learning-rate multiplier for the weights that read the newly added characters")
    ap.add_argument("--special-share", type=float, default=0.3,
                    help="share of composed words drawn from words with newly added characters")
    ap.add_argument("--patience", type=int, default=8)
    ap.add_argument("--sample-every", type=int, default=5)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0, help="stop after this many minutes (0 = no limit)")
    args = ap.parse_args(argv)

    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    os.makedirs(args.out, exist_ok=True)
    ensure_base(args.base)
    with open(os.path.join(args.base, "stats.json")) as f:
        base_stats = json.load(f)

    charset = Charset(DEFAULT_CHARSET)
    model, base_meta = build_model(args.init or args.base, charset)
    model.to(device)
    mu, std = base_meta["mu"], base_meta["std"]

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    inks, report = load_corpus_inks(args.cache, base_stats, token, fetch=not args.no_fetch)
    corpus = Corpus(inks, report, charset, mu, std, seed=args.seed, special_share=args.special_share)
    val_real, val_comp = corpus.validation()
    print("data:", json.dumps({**corpus.counts, "gap_xh": [round(g, 2) for g in corpus.gap],
                               "xh_model": round(report["xh_model"], 1), "excluded": report["excluded"],
                               "sources": report["counts"]}))

    meta = {"charset": charset.chars, "mu": mu, "std": std, "xh_model": report["xh_model"],
            "step_xh": report["step_xh"], "gap_xh": list(corpus.gap), "tall_ratio": report["tall_ratio"],
            "base": os.path.basename(os.path.normpath(args.base)), "data": report["counts"]}

    def save(name: str, extra: dict):
        Synthesizer(model, charset, mu, std, dict(meta)).save(os.path.join(args.out, name), extra)

    def to_dev(batch):
        return [t.to(device) for t in batch]

    @torch.no_grad()
    def evaluate_dev(items):
        if not items:
            return float("nan")
        model.eval()
        total, n = 0.0, 0
        for b in batches(items, 48):
            x, xl, tk, tl = to_dev(b)
            total += float(model.nll(x, xl, tk, tl).sum())
            n += int(xl.sum())
        return total / max(n, 1)

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    # The appended characters (umlauts, sharp s ...) start as copies of similar
    # base letters.  Fine-tuning takes only a few hundred small steps -- enough
    # to bend a hand, far too little to pull "ä" away from "a".  The rows of
    # weights that read those characters therefore move `new_char_boost` times
    # as far per step as everything else.
    n_base, H = len(BASE_CHARSET) + 1, model.hidden_size
    new_idx = torch.arange(n_base, charset.size, device=device)
    boosted = [(model.lstm1.W_xh, 3 + new_idx), (model.lstm2.W_xh, 3 + H + new_idx),
               (model.lstm3.W_xh, 3 + H + new_idx)] if args.new_char_boost != 1.0 and len(new_idx) else []
    steps_per_epoch = math.ceil((args.composed + args.real_repeat * len(corpus.train_real)) / args.batch)
    total_steps = steps_per_epoch * args.epochs
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (args.lr_final + 0.5 * (args.lr - args.lr_final) *
                        (1 + math.cos(math.pi * min(s, total_steps) / total_steps))) / args.lr)

    v_real, v_comp = evaluate_dev(val_real), evaluate_dev(val_comp)
    print(f"epoch  0 | before training | val real {v_real:.4f} | val composed {v_comp:.4f}")
    history = [dict(epoch=0, val_real=v_real, val_composed=v_comp)]
    best, best_epoch, t0 = float("inf"), 0, time.time()
    rng = np.random.default_rng(args.seed + 1)

    for epoch in range(1, args.epochs + 1):
        model.train()
        items = corpus.epoch(args.composed, args.real_repeat)
        run, pts, t_ep = 0.0, 0, time.time()
        for b in batches(items, args.batch, rng):
            x, xl, tk, tl = to_dev(b)
            nll = model.nll(x, xl, tk, tl)
            loss = nll.sum() / xl.sum()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
            before = [W.detach()[rows].clone() for W, rows in boosted]
            opt.step()
            with torch.no_grad():
                for (W, rows), b in zip(boosted, before):
                    W[rows] = b + args.new_char_boost * (W[rows] - b)
            sched.step()
            run += float(nll.detach().sum())
            pts += int(xl.sum())
        v_real, v_comp = evaluate_dev(val_real), evaluate_dev(val_comp)
        # real lines are what we want to imitate; composed lines keep the score stable
        score = v_comp if math.isnan(v_real) else 0.5 * (v_real + v_comp)
        flag = ""
        if score < best:
            best, best_epoch, flag = score, epoch, " *"
            save("best", {"epoch": epoch, "val_real": v_real, "val_composed": v_comp})
        history.append(dict(epoch=epoch, train=run / pts, val_real=v_real, val_composed=v_comp,
                            seconds=time.time() - t_ep))
        print(f"epoch {epoch:2d} | train {run / pts:.4f} | val real {v_real:.4f} | val composed {v_comp:.4f}"
              f" | {time.time() - t_ep:.0f}s | lr {sched.get_last_lr()[0]:.1e}{flag}", flush=True)
        save("last", {"epoch": epoch})
        with open(os.path.join(args.out, "history.json"), "w") as f:
            json.dump(history, f, indent=1)
        if args.sample_every and epoch % args.sample_every == 0:
            sample_sheet(model, charset, mu, std, meta, corpus, os.path.join(args.out, f"samples_{epoch:03d}.png"))
        if epoch - best_epoch >= args.patience:
            print(f"no improvement for {args.patience} epochs, stopping")
            break
        if args.max_minutes and (time.time() - t0) / 60 > args.max_minutes:
            print("time limit reached, stopping")
            break
    print(f"best epoch {best_epoch}, score {best:.4f}, total {(time.time() - t0) / 60:.1f} min")


@torch.no_grad()
def sample_sheet(model, charset, mu, std, meta, corpus: Corpus, path: str, seed: int = 0):
    """Generated lines next to real held-out lines of the writer."""
    was_training = model.training
    dev = next(model.parameters()).device
    syn = Synthesizer(model.cpu(), charset, mu, std, meta)
    real = corpus.val_real[:4]
    texts = SAMPLE_TEXTS + [r.text for r in real]
    gen = syn.write(texts, bias=0.8, seed=seed)
    scale = 1.0 / meta["xh_model"]
    for g in gen:
        g.points[:, :2] *= scale
    inks = gen[: len(SAMPLE_TEXTS)]
    titles = ["generiert: " + t for t in SAMPLE_TEXTS]
    colors = ["tab:blue"] * len(SAMPLE_TEXTS)
    for r, g in zip(real, gen[len(SAMPLE_TEXTS):]):
        inks += [r, g]
        titles += ["ECHT: " + r.text, "generiert: " + r.text]
        colors += ["k", "tab:blue"]
    contact_sheet(inks, path, titles=titles, colors=colors, row_height=1.0)
    model.to(dev)
    model.train(was_training)


if __name__ == "__main__":
    main()

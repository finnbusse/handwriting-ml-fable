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
  * a fixed, short budget of updates with a falling learning rate; what is
    saved is a running average of the weights (steadier than any single step)
  * held-out lines are judged after correcting for over-confidence: with
    little data the network soon predicts too narrow a spread, which makes the
    plain likelihood worse although the writing keeps getting better.  One
    constant added to all predicted log standard deviations removes that; it
    is folded into the saved weights, so the model writes at the writer's
    letter size
"""
from __future__ import annotations

import argparse
import collections
import contextlib
import json
import math
import os
import pickle
import shutil
import time

import numpy as np
import torch

from . import dataset, sources
from .base import ensure_base
from .config import MAIN_WRITER
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
        # Without recordings of single words, the words for composing new lines
        # are cut out of the real lines (never mixing training and held-out lines).
        if len(tw) < 50:
            tw = tw + [w for l in tl for w in (dataset.split_words(l) or [])]
            vw = vw + [w for l in vl for w in (dataset.split_words(l) or [])]
        gap_mean, gap_sd = dataset.measure_gaps(tl + vl)
        self.gap = (gap_mean, gap_sd)
        new_chars = charset.chars[len(BASE_CHARSET):]
        self.composer = dataset.LineComposer(tw, gap_mean, gap_sd, max_points=max_points, seed=seed,
                                             special_chars=new_chars, special_share=special_share)
        self.train_real = self._real(tl)
        self.train_lines = tl
        self._line_words = {l.id: dataset.split_words(l) for l in tl}
        self._pieces_of = collections.defaultdict(list)
        for piece in self.train_real:
            self._pieces_of[piece.meta.get("line", piece.id)].append(piece)
        self._queue: list[int] = []
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

    def window(self, line: Ink) -> Ink | None:
        """A fresh piece of a real line: consecutive words from a random start.

        Cutting every line at the same places would show the network the same
        few pieces a hundred times, nearly all of them starting at the start of
        a sentence, while the page later asks for pieces from the middle of
        running text.  A line offers many such windows; each draw takes
        another one (the true line start in about a third of the draws)."""
        words = self._line_words.get(line.id)
        if not words or len(words) < 2:
            return None
        n = len(words)
        rest = [sum(len(w.text) for w in words[k:]) + (n - k - 1) for k in range(n)]
        starts = [k for k in range(n) if rest[k] >= 12] or [0]
        k = 0 if self.rng.random() < 0.35 else int(self.rng.choice(starts))
        target = int(self.rng.integers(12, 31))
        picked, n_pts, n_chr = [], 0, 0
        for w in words[k:]:
            more = len(w.text) + (1 if picked else 0)
            if picked and (n_pts + len(w) > self.max_points or n_chr + more > target):
                break
            picked.append(w)
            n_pts, n_chr = n_pts + len(w), n_chr + more
        if n_pts > self.max_points:
            return None
        pts = np.vstack([w.points for w in picked])
        pts[:, 0] -= pts[:, 0].min()
        return Ink(pts, text=" ".join(w.text for w in picked), id=f"{line.id}@{k}", source=line.source,
                   kind="line", meta={"line": line.id})

    def epoch(self, n_items: int, real_share: float, max_repeat: int = 6):
        """One epoch's worth of training lines: pieces of real lines and lines
        composed of single words.  Real lines are what the result should look
        like, so they get `real_share` of the epoch -- but no more than
        `max_repeat` draws per piece there is, so that a small set of lines is
        not learnt by heart.  All lines are used equally often."""
        n_real = min(round(n_items * real_share), max_repeat * len(self.train_real))
        real = []
        while len(real) < n_real and self.train_lines:
            if not self._queue:
                self._queue = [int(k) for k in self.rng.permutation(len(self.train_lines))]
            line = self.train_lines[self._queue.pop()]
            piece = self.window(line)
            if piece is None:                       # a line whose words cannot be told apart: its fixed pieces
                fixed = self._pieces_of.get(line.id)
                if not fixed:
                    continue
                piece = fixed[int(self.rng.integers(len(fixed)))]
            real.append(piece)
        items = [self.encode(i, True) for i in real]
        items += [self.encode(self.composer.sample(), True) for _ in range(n_items - len(real))]
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
                     extra_sources: dict | None = None, writer: str | None = None, legacy: bool = True,
                     lines_only: bool = False):
    raw = sources.load_all(cache, token=token, fetch=fetch, extra=extra_sources, writer=writer, legacy=legacy,
                           lines_only=lines_only)
    raw, excluded = dataset.apply_exclusions(raw, dataset.load_exclusions())
    inks, report = dataset.calibrate_cached(raw, base_stats, cache)
    report["excluded"] = excluded
    return inks, report


def main(argv=None, hooks=None):
    """Train.  `hooks` (optional, used by scripts/retrain.py to report progress):
    hooks.started(info) once the data is ready, hooks.epoch(info) after every
    epoch, hooks.finished(info) at the end with the best weights loaded.  When
    started() or epoch() returns True, training ends there (after saving)."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="runs/v1")
    ap.add_argument("--base", default="artifacts/base", help="directory with model.pt, meta.json, stats.json")
    ap.add_argument("--init", default=None, help="continue from this checkpoint directory instead of the base")
    ap.add_argument("--resume-from", default=None,
                    help="continue an interrupted run: a directory with last/, best/, train_state.json, history.json "
                         "as written into --out by an earlier run")
    ap.add_argument("--cache", default="data_cache")
    ap.add_argument("--no-fetch", action="store_true", help="use the local data cache only")
    ap.add_argument("--writer", default=MAIN_WRITER, help="whose recordings of the capture app to train on")
    ap.add_argument("--no-legacy", action="store_true",
                    help="leave out the older datasets (they all belong to the main writer)")
    ap.add_argument("--lines-only", action="store_true",
                    help="train on whole written lines only (October 2025 and the capture app), "
                         "without the early single-word and digit recordings")
    ap.add_argument("--epochs", type=int, default=12,
                    help="a fixed budget: with little data more rounds only learn the lines by heart")
    ap.add_argument("--epoch-items", type=int, default=960, help="training lines per epoch")
    ap.add_argument("--real-share", type=float, default=0.7,
                    help="share of an epoch taken from real written lines; the rest is composed of single words")
    ap.add_argument("--batch", type=int, default=12)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lr-final", type=float, default=2e-5)
    ap.add_argument("--clip", type=float, default=5.0)
    ap.add_argument("--new-char-boost", type=float, default=5.0,
                    help="learning-rate multiplier for the weights that read the newly added characters")
    ap.add_argument("--special-share", type=float, default=0.3,
                    help="share of composed words drawn from words with newly added characters")
    ap.add_argument("--patience", type=int, default=0,
                    help="stop after this many epochs without a better held-out score (0 = run the whole budget)")
    ap.add_argument("--ema", type=float, default=0.995,
                    help="decay of the running average of the weights that is evaluated and saved (0 = off)")
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
    resumed = None
    if args.resume_from:
        with open(os.path.join(args.resume_from, "train_state.json"), encoding="utf-8") as f:
            resumed = json.load(f)
        with open(os.path.join(args.resume_from, "history.json"), encoding="utf-8") as f:
            resumed["history"] = json.load(f)
        best_src = os.path.join(args.resume_from, "best")
        if os.path.abspath(best_src) != os.path.abspath(os.path.join(args.out, "best")):
            shutil.copytree(best_src, os.path.join(args.out, "best"), dirs_exist_ok=True)
    model, base_meta = build_model(os.path.join(args.resume_from, "last") if resumed else (args.init or args.base),
                                   charset)
    model.to(device)
    mu, std = base_meta["mu"], base_meta["std"]

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    inks, report = load_corpus_inks(args.cache, base_stats, token, fetch=not args.no_fetch,
                                    writer=args.writer, legacy=not args.no_legacy, lines_only=args.lines_only)
    corpus = Corpus(inks, report, charset, mu, std, seed=args.seed, special_share=args.special_share)
    val_real, val_comp = corpus.validation()
    print("data:", json.dumps({**corpus.counts, "gap_xh": [round(g, 2) for g in corpus.gap],
                               "xh_model": round(report["xh_model"], 1), "excluded": report["excluded"],
                               "sources": report["counts"]}))

    meta = {"charset": charset.chars, "mu": mu, "std": std, "xh_model": report["xh_model"],
            "step_xh": report["step_xh"], "gap_xh": list(corpus.gap), "tall_ratio": report["tall_ratio"],
            "base": os.path.basename(os.path.normpath(args.base)), "data": report["counts"],
            "writer": args.writer, "lines_only": bool(args.lines_only)}

    def save(name: str, extra: dict):
        Synthesizer(model, charset, mu, std, dict(meta)).save(os.path.join(args.out, name), extra)

    def to_dev(batch):
        return [t.to(device) for t in batch]

    SHIFTS = [0.05 * k for k in range(11)]      # constants tried for the spread correction

    @torch.no_grad()
    def evaluate_dev(items):
        """Mean NLL per point, one value per entry of SHIFTS."""
        if not items:
            return np.full(len(SHIFTS), np.nan)
        model.eval()
        total, n = np.zeros(len(SHIFTS)), 0
        for b in batches(items, 48):
            x, xl, tk, tl = to_dev(b)
            total += model.nll_spread(x, xl, tk, tl, SHIFTS).sum(dim=1).cpu().numpy()
            n += int(xl.sum())
        return total / max(n, 1)

    def validate():
        """(val_real, val_composed, shift) at the spread correction that suits the held-out real lines best."""
        r, c = evaluate_dev(val_real), evaluate_dev(val_comp)
        k = int(np.nanargmin(c if np.isnan(r).all() else r))
        return float(r[k]), float(c[k]), SHIFTS[k]

    ema = None                                   # name -> running average of that parameter

    @contextlib.contextmanager
    def exported(shift: float = 0.0):
        """The weights as they are judged and saved: the running average of the
        training weights, with the spread correction folded into the output
        layer (exact, because log sd = W h + b)."""
        params = dict(model.named_parameters())
        backup = {n: p.detach().clone() for n, p in params.items()}
        with torch.no_grad():
            if ema is not None:
                for n, p in params.items():
                    p.copy_(ema[n])
            if shift:
                model.mixture.sd.bias.add_(shift)
        try:
            yield
        finally:
            with torch.no_grad():
                for n, p in params.items():
                    p.copy_(backup[n])

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    # The appended characters (umlauts, sharp s ...) start as copies of similar
    # base letters.  Fine-tuning takes comparatively few, small steps -- enough
    # to bend a hand, too little to pull "ä" away from "a".  Two things help:
    # small batches (many steps per epoch for the same compute) and letting the
    # rows of weights that read those characters move `new_char_boost` times as
    # far per step.  Much larger boosts (20) were tried and damaged the letter
    # shapes; 5 is a compromise.
    n_base, H = len(BASE_CHARSET) + 1, model.hidden_size
    new_idx = torch.arange(n_base, charset.size, device=device)
    boosted = [(model.lstm1.W_xh, 3 + new_idx), (model.lstm2.W_xh, 3 + H + new_idx),
               (model.lstm3.W_xh, 3 + H + new_idx)] if args.new_char_boost != 1.0 and len(new_idx) else []
    steps_per_epoch = math.ceil(args.epoch_items / args.batch)
    total_steps = steps_per_epoch * args.epochs
    start = resumed["epoch"] if resumed else 0
    step0 = start * steps_per_epoch          # a resumed run continues the learning-rate curve where it was
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (args.lr_final + 0.5 * (args.lr - args.lr_final) *
                        (1 + math.cos(math.pi * min(s + step0, total_steps) / total_steps))) / args.lr)

    def score_of(v_real, v_comp):
        # real lines are what we want to imitate; composed lines keep the score stable
        return v_comp if math.isnan(v_real) else 0.75 * v_real + 0.25 * v_comp

    shift = 0.0

    def sampler(path):
        with exported(shift):
            progress_sheet(model, charset, mu, std, meta, corpus, path)

    rng = np.random.default_rng(args.seed + 1)
    if args.ema > 0:
        ema = {n: p.detach().clone() for n, p in model.named_parameters()}
    if resumed:
        history, best, best_epoch = resumed["history"], resumed["best"], resumed["best_epoch"]
        t0 = time.time() - 60 * resumed.get("minutes", 0)
        print(f"resuming after epoch {start} (best epoch {best_epoch})")
        # last/model.pt holds the averaged weights; the raw training weights are next to it when the run
        # is continued on the same machine
        raw = os.path.join(args.resume_from, "last", "raw.pt")
        if os.path.exists(raw):
            model.load_state_dict(load_state(raw))
    else:
        v_real, v_comp, shift = validate()
        print(f"epoch  0 | before training | val real {v_real:.4f} | val composed {v_comp:.4f} | spread +{shift:.2f}")
        history = [dict(epoch=0, val_real=v_real, val_composed=v_comp, score=score_of(v_real, v_comp),
                        sd_shift=shift)]
        best, best_epoch, t0 = float("inf"), 0, time.time()
    n_updates = start * steps_per_epoch
    info = dict(out=args.out, epochs=args.epochs, counts=corpus.counts, history=history, sample=sampler)
    stopped = bool(hooks and hooks.started(dict(info, epoch=start, best_epoch=best_epoch)))

    for epoch in range(start + 1, args.epochs + 1):
        if stopped:
            break
        model.train()
        items = corpus.epoch(args.epoch_items, args.real_share)
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
            if ema is not None:
                n_updates += 1
                d = min(args.ema, (1 + n_updates) / (10 + n_updates))     # follows quickly at first
                with torch.no_grad():
                    for n, p in model.named_parameters():
                        ema[n].mul_(d).add_(p.detach(), alpha=1 - d)
            run += float(nll.detach().sum())
            pts += int(xl.sum())
        with exported():
            v_real, v_comp, shift = validate()
        score = score_of(v_real, v_comp)
        flag = ""
        extra = {"epoch": epoch, "val_real": v_real, "val_composed": v_comp, "sd_shift": shift}
        with exported(shift):
            if score < best:
                best, best_epoch, flag = score, epoch, " *"
                save("best", extra)
            save("last", extra)
        torch.save(model.state_dict(), os.path.join(args.out, "last", "raw.pt"))
        history.append(dict(epoch=epoch, train=run / pts, val_real=v_real, val_composed=v_comp, score=score,
                            sd_shift=shift, seconds=time.time() - t_ep))
        print(f"epoch {epoch:2d} | train {run / pts:.4f} | val real {v_real:.4f} | val composed {v_comp:.4f}"
              f" | spread +{shift:.2f} | {time.time() - t_ep:.0f}s | lr {sched.get_last_lr()[0]:.1e}{flag}", flush=True)
        with open(os.path.join(args.out, "history.json"), "w") as f:
            json.dump(history, f, indent=1)
        with open(os.path.join(args.out, "train_state.json"), "w") as f:
            json.dump(dict(epoch=epoch, epochs=args.epochs, best=best, best_epoch=best_epoch,
                           minutes=(time.time() - t0) / 60), f)
        if args.sample_every and epoch % args.sample_every == 0:
            with exported(shift):
                sample_sheet(model, charset, mu, std, meta, corpus, os.path.join(args.out, f"samples_{epoch:03d}.png"))
        if hooks and hooks.epoch(dict(info, epoch=epoch, best_epoch=best_epoch, minutes=(time.time() - t0) / 60)):
            print("stop requested, stopping")
            stopped = True
            break
        if args.patience and epoch - best_epoch >= args.patience:
            print(f"no improvement for {args.patience} epochs, stopping")
            break
        if args.max_minutes and (time.time() - t0) / 60 > args.max_minutes:
            print("time limit reached, stopping")
            break
    # The held-out lines cannot tell epochs apart whose scores differ by less than about 0.01 (two standard
    # errors).  Among those the last one has seen the rare characters most often, so it is the one to keep.
    last = history[-1]
    if not stopped and last["epoch"] != best_epoch and last.get("score", float("inf")) <= best + 0.01:
        shutil.copytree(os.path.join(args.out, "last"), os.path.join(args.out, "best"), dirs_exist_ok=True)
        raw = os.path.join(args.out, "best", "raw.pt")
        if os.path.exists(raw):
            os.remove(raw)
        print(f"epoch {last['epoch']} is within 0.01 of the best epoch {best_epoch}: keeping epoch {last['epoch']}")
        best_epoch = last["epoch"]
    print(f"best epoch {best_epoch}, score {best:.4f}, total {(time.time() - t0) / 60:.1f} min")
    result = dict(best_epoch=best_epoch, best=best, epoch=history[-1]["epoch"], stopped=stopped,
                  minutes=(time.time() - t0) / 60)
    if hooks:
        best_pt = os.path.join(args.out, "best", "model.pt")
        if os.path.exists(best_pt):
            model.load_state_dict(load_state(best_pt))
        hooks.finished(dict(info, **result))
    return result


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


@torch.no_grad()
def progress_sheet(model, charset, mu, std, meta, corpus: Corpus, path: str, n: int = 3, seed: int = 0):
    """A small picture of the progress: a few held-out lines of the writer
    (black), each with the model's attempt at the same text below (blue)."""
    was_training = model.training
    dev = next(model.parameters()).device
    real = corpus.val_real[:n] or corpus.train_real[:n]
    gen = Synthesizer(model.cpu(), charset, mu, std, meta).write([r.text for r in real], bias=0.8, seed=seed)
    inks, titles, colors = [], [], []
    for r, g in zip(real, gen):
        g.points[:, :2] /= meta["xh_model"]
        inks += [r, g]
        titles += ["Deine Schrift: " + r.text, "Modell: " + r.text]
        colors += ["k", "#2141B8"]
    contact_sheet(inks, path, titles=titles, colors=colors, row_height=0.85, width=10.0, dpi=100)
    model.to(dev)
    model.train(was_training)


if __name__ == "__main__":
    main()

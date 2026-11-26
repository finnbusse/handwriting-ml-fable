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
  * a fixed budget of 20 rounds with a falling learning rate; what is saved
    is a running average of the weights (steadier than any single step), and
    the last round is the one kept: the held-out likelihood prefers a round
    near 12, yet on written samples the last round is as steady and sets more
    dots (old recipe: 69 % against 63 % of the dots, 11 % against 13 % of the
    delivered pieces lacking one)
  * the dots of i, j and the umlauts count four times in the loss: whether to
    go back for a dot is one decision in hundreds of points and the one the
    network got wrong most often (pieces lacking a dot at the first attempt:
    16 % without the weight, 4 % with it; no more false dots)
  * the pen position the network is shown carries a small random error and the
    target leads back to the true path (jittered): teacher forcing never shows
    the network its own deviations.  A reader trained on the real recordings
    misreads 7 points fewer of the written pieces with it
  * every word of a recorded line is set on the line first, and a line keeps
    only half of its deviation from its session's letter size: written pages
    then vary less in level and size
  * held-out lines are judged after correcting for over-confidence: with
    little data the network soon predicts too narrow a spread, which makes the
    plain likelihood worse although the writing keeps getting better.  One
    constant added to all predicted log standard deviations removes that.  It
    is only a way of scoring: the saved weights stay as trained.  (Folding the
    constant into them was tried and made the writing unsteady: 10 % more
    spread at every pen step let the pen slide off the line in 3.6 % of the
    written pieces instead of 0.6 %.  The letter size the narrow spread costs
    is restored by the page layout, see hw/page.py: measure_size.)
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
from torch import Tensor

from . import dataset, prep, sources
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
# Length aimed at for a piece of a real line, in characters (lowest, highest);
# a piece also ends at max_points, which is about 31 characters.  The pieces
# have to be at least as long as what is written later.  With 12-30 (half of
# the pieces under 18 characters, 15 % with 24 or more) the network wrote short
# pieces well and let the pen slide off the line in 3.5-5 % of the pieces of
# 24-27 characters; a network trained on fixed pieces of up to 34 characters
# (55 % with 24 or more) did so in 1.5 %.  20-44 gives a median of 24
# characters and 56 % with 24 or more.
WINDOW_CHARS = (20, 44)


class Corpus:
    def __init__(self, inks: list[Ink], report: dict, charset: Charset, mu, std, seed: int = 0,
                 max_points: int = dataset.MAX_POINTS, long_points: int = 1250, special_share: float = 0.3,
                 train_all: bool = False, window_chars: tuple[int, int] = WINDOW_CHARS,
                 augment: tuple[float, float] = (1.0, 1.0), dot_weight: float = 1.0):
        self.charset, self.mu, self.std = charset, mu, std
        self.window_chars = window_chars
        self.augment, self.dot_weight = augment, dot_weight
        self.xh_model = report["xh_model"]
        self.max_points, self.long_points = max_points, long_points
        self.rng = np.random.default_rng(seed)
        train, val = dataset.split(inks, train_all=train_all)
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
        self._line_words = {l.id: self.line_words(l) for l in tl}
        self._pieces_of = collections.defaultdict(list)
        for piece in self.train_real:
            self._pieces_of[piece.meta.get("line", piece.id)].append(piece)
        self._queue: list[int] = []
        self.val_real = self._real(vl)
        self.val_lines = vl
        self.val_composed = dataset.LineComposer(vw, gap_mean, gap_sd, max_points=max_points).fixed(160) if vw else []
        self.counts = dict(train_words=len(tw), val_words=len(vw), train_lines=len(tl), val_lines=len(vl),
                           train_real_pieces=len(self.train_real), val_real_pieces=len(self.val_real))

    @staticmethod
    def line_words(line: Ink) -> list[Ink] | None:
        """The words of a real line for drawing windows.  A line the splitter
        gives up on gets a second chance with a smaller minimum gap (as in
        dataset.level_words) and without the ambiguity rule, so that only the
        width check (dataset.word_misfit) decides.  Of the 167 training lines
        23 fail the first split on the ambiguity rule and none on the minimum
        gap.  Looked at one by one, the 18 of them the width check accepts
        (misfit at most 0.94) are cut correctly and the 5 it rejects (2.05 and
        more) are not.  Lines that still do not split enter training whole."""
        return dataset.split_words(line) or dataset.split_words(line, min_gap=0.6, ambiguous=True)

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
        """(points, tokens) for the network; training items of a corpus with a
        dot weight carry a third entry, the weight of every point in the loss."""
        pts = dataset.augment(ink.points, self.rng, *self.augment) if augment else ink.points
        seq = dataset.to_model(ink.copy(points=pts), self.xh_model, self.mu, self.std,
                               max_points=limit or max(self.max_points, len(ink)))
        toks = self.charset.encode(self.charset.normalize(ink.text))
        if augment and self.dot_weight != 1.0:
            return seq, toks, self.point_weights(ink)[:len(seq)]
        return seq, toks

    def point_weights(self, ink: Ink) -> np.ndarray:
        """1 for every point, `dot_weight` for the dots of i, j, ä, ö, ü: the
        points of every dot stroke (the first one is the jump to the dot) and
        the jump back.  Whether to go back for a dot is one decision in
        hundreds of points, and the one the network gets wrong most often."""
        w = np.ones(len(ink.points), dtype=np.float32)
        for s in prep.dot_slices(ink):
            w[s.start:s.stop + 1] = self.dot_weight
        return w

    def window(self, line: Ink) -> Ink | None:
        """A fresh piece of a real line: consecutive words from a random start.

        Cutting every line at the same places would show the network the same
        few pieces a hundred times, nearly all of them starting at the start of
        a sentence, while the page later asks for pieces from the middle of
        running text.  A line offers many such windows; each draw takes
        another one (the true line start in about a third of the draws).

        The length aimed at is drawn from `window_chars`; see WINDOW_CHARS for
        why the pieces must not be short."""
        words = self._line_words.get(line.id)
        if not words or len(words) < 2:
            return None
        n = len(words)
        rest = [sum(len(w.text) for w in words[k:]) + (n - k - 1) for k in range(n)]
        lo, hi = self.window_chars
        starts = [k for k in range(n) if rest[k] >= lo] or [0]
        k = 0 if self.rng.random() < 0.35 else int(self.rng.choice(starts))
        target = int(self.rng.integers(lo, hi + 1))
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


def batches(items, batch_size: int, rng=None, bucket: int = 8, weights: bool = False):
    """Group sequences of similar length; yields padded tensors (with
    `weights` a fifth one: the weight of every point in the loss)."""
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
        w = torch.ones(len(g), T) if weights else None
        for b, (s, t) in enumerate(zip(seqs, toks)):
            x[b, : len(s)] = torch.from_numpy(s)
            tk[b, : len(t)] = torch.tensor(t)
            if weights and len(items[g[b]]) > 2:
                w[b, : len(s)] = torch.from_numpy(items[g[b]][2])
        out = (x, torch.tensor([len(s) for s in seqs]), tk, torch.tensor([len(t) for t in toks]))
        yield out + (w,) if weights else out


def jittered(x: Tensor, sd: float, generator=None) -> tuple[Tensor, Tensor]:
    """(inputs, targets) for training against drift.

    Teacher forcing shows the network a pen that is always exactly where the
    writer's was, so it never learns what to do when its own pen is a little
    off, and free-running errors add up.  Here the pen position the network
    sees is the true one plus a small random error at every point (`sd`, in
    units of the offset normalisation), and the target is the step from that
    wrong position to the true next one: the network is taught to steer back.
    With e(t) the error at point t: input offset x(t) + e(t) - e(t-1), target
    x(t+1) - e(t)."""
    eps = sd * torch.randn(x.shape[0], x.shape[1], 2, generator=generator).to(x.device)
    prev = torch.cat([eps.new_zeros(x.shape[0], 1, 2), eps[:, :-1]], dim=1)       # e(t-1)
    seen, target = x.clone(), x.clone()
    seen[..., :2] += eps - prev
    target[..., :2] -= prev
    inputs = torch.cat([x.new_zeros(x.shape[0], 1, 3), seen[:, :-1]], dim=1)
    return inputs, target


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
                     lines_only: bool = False, calibration: str = "letters", line_size: str = "session"):
    raw = sources.load_all(cache, token=token, fetch=fetch, extra=extra_sources, writer=writer, legacy=legacy,
                           lines_only=lines_only)
    raw, excluded = dataset.apply_exclusions(raw, dataset.load_exclusions())
    inks, report = dataset.calibrate_cached(raw, base_stats, cache, calibration=calibration, line_size=line_size)
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
    ap.add_argument("--window-chars", type=int, nargs=2, default=list(WINDOW_CHARS), metavar=("LOW", "HIGH"),
                    help="length aimed at for a piece of a real line, in characters")
    ap.add_argument("--augment", type=float, nargs=2, default=[1.0, 1.0], metavar=("SHAPE", "PLACE"),
                    help="strength of the random changes to every training piece: width and slant, size and rotation "
                         "(1 1 = as always, 0 0 = none)")
    ap.add_argument("--dot-weight", type=float, default=4.0,
                    help="weight in the loss of the dots of i, j, ä, ö, ü and of the pen jumps to and from them "
                         "(1 = none; 3, 4 and 6 gave the same result within noise)")
    ap.add_argument("--input-noise", type=float, default=0.01,
                    help="train against drift: random error of the pen position the network sees, in units of the "
                         "offset normalisation (see jittered); 0 = off, 0.02 was no better than 0.01")
    ap.add_argument("--level-words", action=argparse.BooleanOptionalAction, default=True,
                    help="set every word of the recorded lines on the line before training (dataset.level_words)")
    ap.add_argument("--calibration", choices=("letters", "chars"), default="letters",
                    help="how characters are counted when the points per character are matched to the base model: "
                         "'letters' without spaces, 'chars' with spaces as the base statistics do (dataset.calibrate)")
    ap.add_argument("--line-size", choices=("session", "blend"), default="blend",
                    help="x-height of a recorded line: its session's median, or that median moved halfway towards "
                         "the line's own size, at most 15 %% (dataset.measure)")
    ap.add_argument("--max-points", type=int, default=dataset.MAX_POINTS,
                    help="longest training piece in points (the base model was trained on at most 700).  With "
                         "--calibration chars a character takes more points: at 700 the windows of real lines shrink "
                         "to a median of 22 characters (55 %% with 22 or more); 800 gives 24 and 70 %% as 'letters' "
                         "does at 700")
    ap.add_argument("--epochs", type=int, default=20,
                    help="a fixed budget (30 rounds measured no better than 20)")
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
    ap.add_argument("--train-all", action="store_true",
                    help="hold out nothing: every line and every word is trained on, no held-out score exists and "
                         "the last epoch is the one kept (for the model that is published, once the recipe is "
                         "settled)")
    ap.add_argument("--sd-shift", type=float, default=None,
                    help="score with this spread correction instead of fitting it on the held-out lines")
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
                                    writer=args.writer, legacy=not args.no_legacy, lines_only=args.lines_only,
                                    calibration=args.calibration, line_size=args.line_size)
    if args.level_words:
        inks = [dataset.level_words(i) if i.kind == "line" else i for i in inks]
    corpus = Corpus(inks, report, charset, mu, std, seed=args.seed, special_share=args.special_share,
                    train_all=args.train_all, window_chars=tuple(args.window_chars), max_points=args.max_points,
                    augment=tuple(args.augment), dot_weight=args.dot_weight)
    val_real, val_comp = corpus.validation()
    print("data:", json.dumps({**corpus.counts, "gap_xh": [round(g, 2) for g in corpus.gap],
                               "xh_model": round(report["xh_model"], 1), "step_xh": round(report["step_xh"], 4),
                               "calibration": args.calibration, "line_size": args.line_size,
                               "excluded": report["excluded"],
                               "sources": report["counts"]}))

    meta = {"charset": charset.chars, "mu": mu, "std": std, "xh_model": report["xh_model"],
            "step_xh": report["step_xh"], "gap_xh": list(corpus.gap), "tall_ratio": report["tall_ratio"],
            "base": os.path.basename(os.path.normpath(args.base)), "data": report["counts"],
            "writer": args.writer, "lines_only": bool(args.lines_only), "level_words": bool(args.level_words),
            "window_chars": list(args.window_chars), "augment": list(args.augment),
            "dot_weight": args.dot_weight, "input_noise": args.input_noise, "calibration": args.calibration,
            "line_size": args.line_size, "max_points": args.max_points}

    def save(name: str, extra: dict):
        Synthesizer(model, charset, mu, std, dict(meta)).save(os.path.join(args.out, name), extra)

    def to_dev(batch):
        return [t.to(device) for t in batch]

    # constants tried for the spread correction; the negative ones show a spread that is too wide
    SHIFTS = [round(0.05 * k, 2) for k in range(-3, 11)]

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
        ref = c if np.isnan(r).all() else r
        if args.sd_shift is not None or np.isnan(ref).all():       # nothing held out, or the correction is given
            k = int(np.argmin([abs(v - (args.sd_shift or 0.0)) for v in SHIFTS]))
            return float(r[k]), float(c[k]), float(args.sd_shift or 0.0)
        k = int(np.nanargmin(ref))
        return float(r[k]), float(c[k]), SHIFTS[k]

    ema = None                                   # name -> running average of that parameter

    @contextlib.contextmanager
    def exported():
        """The weights as they are judged and saved: the running average of the
        training weights."""
        params = dict(model.named_parameters())
        backup = {n: p.detach().clone() for n, p in params.items()}
        with torch.no_grad():
            if ema is not None:
                for n, p in params.items():
                    p.copy_(ema[n])
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
        if math.isnan(v_real):
            return v_comp
        return v_real if math.isnan(v_comp) else 0.75 * v_real + 0.25 * v_comp

    shift = 0.0

    def sampler(path):
        with exported():
            progress_sheet(model, charset, mu, std, meta, corpus, path)

    rng = np.random.default_rng(args.seed + 1)
    noise_gen = torch.Generator().manual_seed(args.seed + 2)
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
        print(f"epoch  0 | before training | val real {v_real:.4f} | val composed {v_comp:.4f} | spread {shift:+.2f}")
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
        for b in batches(items, args.batch, rng, weights=True):
            x, xl, tk, tl, w = to_dev(b)
            inputs, target = jittered(x, args.input_noise, noise_gen) if args.input_noise > 0 else (None, x)
            mask = (torch.arange(x.shape[1], device=device)[None, :] < xl[:, None]).float()
            per_point = -model.forward(target, tk, tl, inputs=inputs).log_prob(target) * mask
            nll = per_point.sum(dim=1)                       # what is reported: every point counts once
            loss = (per_point * w).sum() / xl.sum()
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
        extra = {"epoch": epoch, "val_real": v_real, "val_composed": v_comp, "spread_fit": shift}
        with exported():
            if score < best or math.isnan(score):          # without held-out lines the newest epoch is the one to keep
                best, best_epoch, flag = (best if math.isnan(score) else score), epoch, " *"
                save("best", extra)
            save("last", extra)
        torch.save(model.state_dict(), os.path.join(args.out, "last", "raw.pt"))
        history.append(dict(epoch=epoch, train=run / pts, val_real=v_real, val_composed=v_comp, score=score,
                            sd_shift=shift, seconds=time.time() - t_ep))
        print(f"epoch {epoch:2d} | train {run / pts:.4f} | val real {v_real:.4f} | val composed {v_comp:.4f}"
              f" | spread {shift:+.2f} | {time.time() - t_ep:.0f}s | lr {sched.get_last_lr()[0]:.1e}{flag}", flush=True)
        with open(os.path.join(args.out, "history.json"), "w") as f:
            json.dump(history, f, indent=1)
        with open(os.path.join(args.out, "train_state.json"), "w") as f:
            json.dump(dict(epoch=epoch, epochs=args.epochs, best=best, best_epoch=best_epoch,
                           minutes=(time.time() - t0) / 60), f)
        if args.sample_every and epoch % args.sample_every == 0:
            with exported():
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
    # A run that used its whole budget keeps its last epoch, whatever the held-out score says: the score
    # prefers an epoch near 12 of 20, but written samples of the last epoch are as steady and carry more dots,
    # and it has seen the rare characters most often.  (A run that was stopped or ran out of time keeps the
    # epoch with the best score.)
    last = history[-1]
    if not stopped and last["epoch"] >= args.epochs and last["epoch"] != best_epoch:
        shutil.copytree(os.path.join(args.out, "last"), os.path.join(args.out, "best"), dirs_exist_ok=True)
        raw = os.path.join(args.out, "best", "raw.pt")
        if os.path.exists(raw):
            os.remove(raw)
        print(f"keeping the last epoch {last['epoch']} (best held-out score: epoch {best_epoch})")
        best_epoch = last["epoch"]
    print(f"best epoch {best_epoch}, score {best:.4f}, total {(time.time() - t0) / 60:.1f} min")
    # How large the kept model writes at each legibility setting; the page layout scales words back with it.
    best_meta = os.path.join(args.out, "best", "meta.json")
    if os.path.exists(best_meta):
        from .page import measure_size

        table = measure_size(Synthesizer.load(os.path.join(args.out, "best")))
        with open(best_meta, encoding="utf-8") as f:
            kept = json.load(f)
        kept["size_by_bias"] = table
        with open(best_meta, "w", encoding="utf-8") as f:
            json.dump(kept, f, ensure_ascii=False, indent=1)
        print("letter size by legibility setting:", json.dumps(table))
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

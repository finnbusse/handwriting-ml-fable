"""Retrain when there are new recordings -- used by the GitHub workflow (which the
web app's Training tab starts) and the Colab notebook, and fine to run by hand.

    python scripts/retrain.py check     # is there anything new?  (exit code 0, prints needed=true/false)
    python scripts/retrain.py run       # train, compare, publish

"New" means: the set of line files of the main writer in `<user>/handwriting-fable`
differs from what the published model was trained on (`trained_on.json` in the
model repo records a hash of that list).  A run is a full run from the pretrained
base by default, uses ALL recordings (old and new) and stops by itself when the
held-out lines stop improving.  Needs HF_TOKEN.

While it runs, `run` reports into the model repo after every epoch (see
hw/progress.py): training/status.json, training/sample.png and, every few
epochs, training/checkpoint/ -- the web app's Training tab shows these.  A file
training/stop in the model repo (the app's "Abbrechen") ends the run after the
current epoch; `run --resume-run` continues it later from training/checkpoint/.
"""
import argparse
import datetime
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)                                   # the repo root, for "hw"
sys.path.insert(0, os.path.join(ROOT, "scripts"))          # publish_model
from hw import models, progress  # noqa: E402
from hw.config import MAIN_WRITER  # noqa: E402

DATASET = "handwriting-fable"
MODEL = "handwriting-fable-model"

# Defaults of `run` (the Training tab of the web app shows and uses these).
LINES_ONLY = False      # train on whole written lines only, without the early single words and digits
EPOCHS = 12             # a fixed budget of rounds (hw/train.py explains why it is short and fixed)
SAMPLE_EVERY = 1        # draw training/sample.png every this many epochs (it takes a few seconds)
CHECKPOINT_EVERY = 4    # store training/checkpoint/ every this many epochs (about 30 MB each time)
MAX_MINUTES = 240       # stop training after this long and publish the best model so far


def token_from_env():
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")


def hf_hub():
    token = token_from_env()
    if not token:
        sys.exit("HF_TOKEN is not set (GitHub: Settings > Secrets and variables > Actions; Colab: the key icon).")
    return progress.HfHub(token, DATASET, MODEL)


def state(hub, writer=MAIN_WRITER):
    st = hub.dataset_state(writer)
    files, trained = st["files"], st["trained"] or {}
    return {"dataset": st["dataset"], "dataset_sha": st["dataset_sha"], "lines": len(files),
            "lines_sha256": progress.lines_digest(files),
            "trained_lines_sha256": trained.get("lines_sha256"), "trained_lines": trained.get("lines", 0)}


def out(key, value):
    print(f"{key}={value}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"{key}={value}\n")


def summary(text):
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text + "\n")


def check(args):
    st = state(hf_hub())
    new = st["lines"] - st["trained_lines"]
    needed = args.force or (st["lines_sha256"] != st["trained_lines_sha256"] and new >= args.min_new)
    out("needed", "true" if needed else "false")
    summary(f"Aufnahmen im Dataset: {st['lines']} Zeilen, davon beim letzten Training bekannt: {st['trained_lines']}. "
            + ("Es wird neu trainiert." if needed else
               f"Noch kein Training: Es lohnt sich erst ab {args.min_new} neuen Zeilen (oder von Hand mit 'force')."))


# ------------------------------------------------------------------------ run
class Hooks:
    """Called by hw.train: turns every epoch into one progress commit."""

    def __init__(self, prog, stop, args, run_meta, uploaded_best=None, log=print):
        self.prog, self.stop, self.args, self.run_meta, self.log = prog, stop, args, run_meta, log
        self.sample_every = max(0, args.sample_every)
        self.uploaded_best = uploaded_best
        self.final = None
        self.sample_path = os.path.join(args.out, "progress_sample.png")

    def _sample(self, info, epoch, kind="progress"):
        t = time.time()
        try:
            info["sample"](self.sample_path)
        except Exception as e:                       # a picture is never worth a failed run
            self.log(f"warning: sample failed ({type(e).__name__}: {e})")
            return {}
        took = time.time() - t
        if took > 60 and self.sample_every:          # too slow for every epoch: draw it less often
            self.sample_every = max(self.sample_every, 3)
        self.prog.update(sample_epoch=epoch, sample_kind=kind)
        return {progress.SAMPLE: self.sample_path}

    def _checkpoint(self, info, epoch):
        if not os.path.exists(os.path.join(self.args.out, "train_state.json")):
            return {}
        best = info["best_epoch"]
        files = progress.checkpoint_files(self.args.out, self.run_meta, with_best=best != self.uploaded_best)
        self.uploaded_best = best
        self.prog.update(checkpoint_epoch=epoch)
        return files

    def started(self, info):
        self.prog.update(data=info["counts"], epochs=info["epochs"],
                         resumed_from=info["epoch"] or None)
        self.prog.from_history(info["history"], info["epoch"], info["best_epoch"] or None, 0.0,
                               self.args.max_minutes)
        if self.stop.requested():
            return True
        files = self._sample(info, info["epoch"]) if self.sample_every and not info["epoch"] else {}
        self.prog.publish("running", files=files)
        return False

    def epoch(self, info):
        e = info["epoch"]
        self.prog.from_history(info["history"], e, info["best_epoch"], info["minutes"], self.args.max_minutes)
        if self.stop.requested():
            return True                              # run() reports "stopped" with the checkpoint
        files = {}
        if self.sample_every and e % self.sample_every == 0:
            files.update(self._sample(info, e))
        if self.args.checkpoint_every and e % self.args.checkpoint_every == 0:
            files.update(self._checkpoint(info, e))
        self.prog.publish("running", files=files)
        return False

    def finished(self, info):
        self.final = info


def train_argv(args, epochs, lines_only, threads, resume_dir=None, init_dir=None):
    argv = ["--out", args.out, "--epochs", str(epochs), "--max-minutes", str(args.max_minutes),
            "--threads", str(threads), "--cache", args.cache, "--base", args.base, "--writer", args.writer]
    if lines_only:
        argv.append("--lines-only")
    if args.no_fetch:
        argv.append("--no-fetch")
    if args.epoch_items:
        argv += ["--epoch-items", str(args.epoch_items)]
    if resume_dir:
        argv += ["--resume-from", resume_dir]
    elif init_dir:
        argv += ["--init", init_dir]
    return argv


def _on_sigterm(signum, frame):
    raise progress.Interrupted()


def run(args, hub=None, train_main=None):
    """Train, compare, publish -- and report every step into the model repo."""
    from hw import train as hw_train

    train_main = train_main or hw_train.main
    hub = hub or hf_hub()
    token = getattr(hub, "token", None)
    work = args.out
    os.makedirs(work, exist_ok=True)
    threads = args.threads or os.cpu_count() or 2
    lines_only = LINES_ONLY if args.lines_only is None else args.lines_only
    epochs = args.epochs or EPOCHS
    prog = progress.Progress(hub, runner=args.runner or progress.detect_runner(), epochs=epochs,
                             run_id=args.run_id, writer=args.writer, lines_only=lines_only)
    stop = progress.StopWatch(hub, local_flag=os.environ.get("HW_STOP_FILE"))

    # The first status must arrive: a token that cannot write is reported at once.
    try:
        hub.ensure_repo()
        stale = [progress.STOP] if hub.exists(progress.STOP) else []   # a stop request left from an earlier run
        prog.publish("starting", delete=stale, strict=True)
    except Exception as e:
        print(f"Fehler: {progress.german_message(e)}", file=sys.stderr, flush=True)
        raise
    if threading_is_main():
        signal.signal(signal.SIGTERM, _on_sigterm)

    hooks = None
    try:
        resume_dir, init_dir, prev_best = None, None, None
        if args.resume_run:
            resume_dir = os.path.join(work, "resume")
            try:
                prev = progress.fetch_checkpoint(hub, resume_dir)
            except FileNotFoundError as e:
                raise progress.NoCheckpoint(str(e)) from None
            epochs = args.epochs or prev.get("epochs") or EPOCHS
            if args.lines_only is None:
                lines_only = bool(prev.get("lines_only", LINES_ONLY))
            with open(os.path.join(resume_dir, "train_state.json"), encoding="utf-8") as f:
                prev_best = json.load(f).get("best_epoch")
            prog.update(epochs=epochs, lines_only=lines_only)
        elif args.resume:      # continue from the published checkpoint instead of a full run
            try:
                init_dir = os.path.join(work, "init")
                for name in ("model.pt", "meta.json"):
                    hub.download(f"checkpoint/{name}", os.path.join(init_dir, name))
            except Exception as e:
                init_dir = None
                print(f"no published checkpoint ({type(e).__name__}); starting from the pretrained base")

        st = state(hub, args.writer)
        prog.update(lines=st["lines"])
        run_meta = {"run_id": prog.status["run_id"], "started": prog.status["started"], "epochs": epochs,
                    "lines_only": lines_only, "writer": args.writer, "runner": prog.status["runner"]}
        hooks = Hooks(prog, stop, args, run_meta, uploaded_best=prev_best)
        result = train_main(train_argv(args, epochs, lines_only, threads, resume_dir, init_dir), hooks=hooks)

        if result["stopped"]:
            files = hooks._checkpoint(hooks.final or result, result["epoch"]) if result["epoch"] else {}
            prog.update(message=f"Abgebrochen nach Runde {result['epoch']}.", minutes_left=None)
            prog.publish("stopped", files=files, delete=stop.to_delete())
            summary(f"Training nach Runde {result['epoch']} abgebrochen.")
            return 0

        prog.update(minutes_left=2.0)
        prog.publish("publishing")
        manifest = publish(args, hub, st, threads, lines_only, epochs, prog.status["run_id"], rounds=result["epoch"])
        files = hooks._sample(hooks.final, result["best_epoch"], kind="best") if hooks.final else {}
        prog.update(model_sha256=manifest["sha256"], model_version=manifest.get("version"), minutes_left=0.0,
                    best_epoch=result["best_epoch"])
        prog.publish("done", files=files)
        with open(os.path.join(work, "best", "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        summary(f"Modell neu trainiert und veröffentlicht: {st['lines']} erfasste Zeilen, beste Runde {meta.get('epoch')}, "
                f"Güte auf zurückgehaltenen echten Zeilen {meta.get('val_real'):.3f} (niedriger ist besser).")
        return 0
    except (progress.Interrupted, KeyboardInterrupt):
        files = progress.checkpoint_files(work, hooks.run_meta, True) if hooks and _has_state(work) else {}
        if files:
            prog.update(checkpoint_epoch=_state_epoch(work))
        prog.update(message="Das Training wurde unterbrochen.", minutes_left=None)
        prog.publish("stopped", files=files, delete=stop.to_delete())
        raise SystemExit(130)
    except Exception as e:
        files = progress.checkpoint_files(work, hooks.run_meta, True) if hooks and _has_state(work) else {}
        if files:
            prog.update(checkpoint_epoch=_state_epoch(work))
        prog.update(message=progress.german_message(e), minutes_left=None,
                    error=progress.scrub(f"{type(e).__name__}: {e}", token)[:500])
        prog.publish("failed", files=files)
        print(f"Fehler: {prog.status['message']}", file=sys.stderr, flush=True)
        raise


def threading_is_main():
    import threading

    return threading.current_thread() is threading.main_thread()


def _has_state(work):
    return os.path.exists(os.path.join(work, "train_state.json"))


def _state_epoch(work):
    with open(os.path.join(work, "train_state.json"), encoding="utf-8") as f:
        return json.load(f)["epoch"]


def publish(args, hub, st, threads, lines_only, epochs, run_id, rounds=None):
    """compare.py, then the model as a new version in one commit (scripts/publish_model.py
    prepares the files, hw.models.publish puts them under models/<id>/ and the root)."""
    import publish_model

    py = sys.executable
    env = dict(os.environ, PYTHONPATH=ROOT)
    best = os.path.join(args.out, "best")
    image = os.path.join(args.out, "vergleich.png")
    cmd = [py, os.path.join(ROOT, "scripts", "compare.py"), best, "--out", image, "--threads", str(threads),
           "--cache", args.cache, "--base", args.base, "--writer", args.writer]
    subprocess.run(cmd + (["--lines-only"] if lines_only else []), check=True, env=env)
    marker = {"dataset": st["dataset"], "dataset_sha": st["dataset_sha"], "lines": st["lines"],
              "lines_sha256": st["lines_sha256"], "writer": args.writer, "lines_only": lines_only,
              "epochs": epochs, "rounds": rounds, "run_id": run_id,
              "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    with tempfile.TemporaryDirectory() as tmp:
        marker_path = os.path.join(tmp, "marker.json")
        with open(marker_path, "w", encoding="utf-8") as f:
            json.dump(marker, f)
        folder = os.path.join(tmp, "upload")
        os.makedirs(folder)
        manifest, _ = publish_model.prepare(best, folder, image, marker_path)
        version = models.publish(hub, folder, writer=args.writer, note=getattr(args, "note", None), rounds=rounds,
                                 message=f"Neu trainiert mit {st['lines']} erfassten Zeilen")
    print(f"published as {version['path']}")
    return dict(manifest, version=version["id"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--force", action="store_true")
    c.add_argument("--min-new", type=int, default=20, help="retrain only when at least this many new lines exist")
    r = sub.add_parser("run")
    r.add_argument("--out", default="runs/retrain")
    r.add_argument("--epochs", type=int, default=None, help=f"at most this many epochs (default {EPOCHS}; "
                   "with --resume-run: as in the run that is continued)")
    lo = r.add_mutually_exclusive_group()
    lo.add_argument("--lines-only", dest="lines_only", action="store_true", default=None,
                    help="train on whole written lines only" + (" (default)" if LINES_ONLY else ""))
    lo.add_argument("--all-data", dest="lines_only", action="store_false",
                    help="train on every recording, single words included" + ("" if LINES_ONLY else " (default)"))
    r.add_argument("--resume", action="store_true",
                   help="start from the published checkpoint (default: a full run from the pretrained base, "
                        "which gives the same result no matter what was trained before)")
    r.add_argument("--resume-run", action="store_true",
                   help="continue an interrupted or stopped run from training/checkpoint/ in the model repo")
    r.add_argument("--max-minutes", type=float, default=MAX_MINUTES)
    r.add_argument("--sample-every", type=int, default=SAMPLE_EVERY, help="training/sample.png every N epochs (0: never)")
    r.add_argument("--checkpoint-every", type=int, default=CHECKPOINT_EVERY,
                   help="training/checkpoint/ every N epochs (0: only when the run stops or fails)")
    r.add_argument("--runner", choices=progress.RUNNERS, default=None, help="where this runs (default: detected)")
    r.add_argument("--run-id", default=None)
    r.add_argument("--threads", type=int, default=0, help="CPU threads (default: all)")
    r.add_argument("--epoch-items", type=int, default=0, help="training lines per epoch (default: as hw.train)")
    r.add_argument("--writer", default=MAIN_WRITER)
    r.add_argument("--note", default=None, help="a short note stored with the published model (shown in the app)")
    r.add_argument("--cache", default="data_cache")
    r.add_argument("--base", default="artifacts/base")
    r.add_argument("--no-fetch", action="store_true", help="use the local data cache only")
    r.add_argument("--local-hub", default=None,
                   help="write into this folder instead of the model repo (trying things out, tests)")
    r.add_argument("--local-dataset", default=None,
                   help="with --local-hub: a local copy of the dataset, to count its lines")
    args = ap.parse_args(argv)
    if args.cmd == "check":
        return check(args)
    hub = progress.LocalHub(args.local_hub, args.local_dataset) if args.local_hub else None
    return run(args, hub=hub)


if __name__ == "__main__":
    sys.exit(main())

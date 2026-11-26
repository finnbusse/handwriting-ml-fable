"""Train one variant of the recipe, measure it, and store the result.

    python scripts/experiment.py e16 -- --lines-only --epochs 16

Runs hw.train with the given arguments into runs/exp/<name>, evaluates the
result with scripts/evaluate.py and, with --upload, stores model, history,
metrics and sheets in the model repo under experiments/<name>/ (private; the
published model is not touched).  Used by .github/workflows/experiments.yml to
try several variants side by side on free runners.

    python scripts/experiment.py old-s1 --code-ref 5c53252 -- --epochs 30 --seed 1

trains with hw/ as it was at that commit (or, with --code-paths, with single
files from it); the evaluation always uses the current code, so that recipes
of different dates are measured alike.
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--code-ref", default=None, help="train with hw/ as it was at this commit")
    ap.add_argument("--code-paths", nargs="+", default=["hw"],
                    help="take only these paths from --code-ref (e.g. hw/dataset.py: the old data preparation with "
                         "the current training loop)")
    # everything after "--" belongs to hw.train (argparse's REMAINDER would also swallow our own options)
    argv = sys.argv[1:]
    cut = argv.index("--") if "--" in argv else len(argv)
    args, extra = ap.parse_args(argv[:cut]), argv[cut + 1:]
    out = os.path.join("runs", "exp", args.name)
    env = dict(os.environ, PYTHONPATH=ROOT)
    threads = str(os.cpu_count() or 2)
    git = lambda *a: subprocess.run(["git", *a], check=True, cwd=ROOT)
    if args.code_ref:
        have = subprocess.run(["git", "cat-file", "-e", args.code_ref + "^{commit}"], cwd=ROOT, capture_output=True).returncode == 0
        if not have:                                # a runner's checkout holds the newest commit only
            shallow = subprocess.run(["git", "rev-parse", "--is-shallow-repository"], cwd=ROOT, capture_output=True,
                                     text=True).stdout.strip() == "true"
            git("fetch", *(["--depth", "1"] if shallow else []), "origin", args.code_ref)
        git("checkout", args.code_ref, "--", *args.code_paths)
    try:
        subprocess.run([sys.executable, "-m", "hw.train", "--out", out, "--threads", threads, "--sample-every", "0"] + extra,
                       check=True, env=env, cwd=ROOT)
    finally:
        if args.code_ref:
            git("checkout", "HEAD", "--", *args.code_paths)

    def epoch_of(which):
        with open(os.path.join(out, which, "meta.json"), encoding="utf-8") as f:
            return json.load(f).get("epoch")

    def evaluate(which, folder):
        subprocess.run([sys.executable, "scripts/evaluate.py", os.path.join(out, which), "--out", os.path.join(out, folder),
                        "--seeds", str(args.seeds), "--threads", threads], check=True, env=env, cwd=ROOT)

    evaluate("best", "eval")
    if os.path.exists(os.path.join(out, "last", "meta.json")) and epoch_of("last") != epoch_of("best"):
        evaluate("last", "eval_last")              # the end of the budget, when an earlier epoch was kept
    with open(os.path.join(out, "args.json"), "w") as f:
        json.dump({"name": args.name, "train_args": extra, "code_ref": args.code_ref,
                   "code_paths": args.code_paths if args.code_ref else None}, f)
    if args.upload:
        from huggingface_hub import HfApi

        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
        api = HfApi(token=token)
        repo = f"{api.whoami()['name']}/handwriting-fable-model"
        raw = os.path.join(out, "last", "raw.pt")
        if os.path.exists(raw):
            os.remove(raw)                      # only needed to continue a run on the same machine
        api.upload_folder(folder_path=out, repo_id=repo, repo_type="model", path_in_repo=f"experiments/{args.name}",
                          commit_message=f"Versuch {args.name}", delete_patterns=["*"])
        print(f"stored in {repo}/experiments/{args.name}")
    with open(os.path.join(out, "eval", "metrics.json")) as f:
        m = json.load(f)
    line = (f"**{args.name}** `{' '.join(extra)}`{' @ ' + args.code_ref if args.code_ref else ''}: Runde {m['epoch']}, "
            f"erste Versuche sauber {m['first_try']:.0%}, abgedriftet {m['drift']:.1%}, Punkte {m['dots']:.0%} "
            f"(große Umlaute {m['dots_capital_umlauts']:.0%}), nach Neuversuchen fehlerhaft {m['delivered_faulty']:.1%}, "
            f"ohne Punkt {m['delivered_missing_dots']:.0%}")
    print(line)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(line + "\n")


if __name__ == "__main__":
    main()

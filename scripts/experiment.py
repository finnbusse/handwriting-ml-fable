"""Train one variant of the recipe, measure it, and store the result.

    python scripts/experiment.py e16 -- --lines-only --epochs 16

Runs hw.train with the given arguments into runs/exp/<name>, evaluates the
result with scripts/evaluate.py and, with --upload, stores model, history,
metrics and sheets in the model repo under experiments/<name>/ (private; the
published model is not touched).  Used by .github/workflows/experiments.yml to
try several variants side by side on free runners.
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
    ap.add_argument("train_args", nargs=argparse.REMAINDER, help="after --: arguments for hw.train")
    args = ap.parse_args()
    extra = [a for a in args.train_args if a != "--"]
    out = os.path.join("runs", "exp", args.name)
    env = dict(os.environ, PYTHONPATH=ROOT)
    threads = str(os.cpu_count() or 2)
    subprocess.run([sys.executable, "-m", "hw.train", "--out", out, "--threads", threads, "--sample-every", "0"] + extra,
                   check=True, env=env, cwd=ROOT)
    subprocess.run([sys.executable, "scripts/evaluate.py", os.path.join(out, "best"), "--out", os.path.join(out, "eval"),
                    "--seeds", str(args.seeds), "--threads", threads], check=True, env=env, cwd=ROOT)
    with open(os.path.join(out, "args.json"), "w") as f:
        json.dump({"name": args.name, "train_args": extra}, f)
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
    line = (f"**{args.name}** `{' '.join(extra)}`: erste Versuche sauber {m['first_try']:.0%}, Punkte {m['dots']:.0%} "
            f"(große Umlaute {m['dots_capital_umlauts']:.0%}), Schlusspunkt {m['final_stop']:.0%}, "
            f"Strichhöhe {m['stroke_height_ratio']:.2f} der echten")
    print(line)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(line + "\n")


if __name__ == "__main__":
    main()

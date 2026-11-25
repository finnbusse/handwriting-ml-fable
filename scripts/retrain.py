"""Retrain when there are new recordings -- used by the GitHub workflow and the
Colab notebook, and fine to run by hand.

    python scripts/retrain.py check     # is there anything new?  (exit code 0, prints needed=true/false)
    python scripts/retrain.py run       # train, compare, publish

"New" means: the set of line files of the main writer in `<user>/handwriting-fable`
differs from what the published model was trained on (`trained_on.json` in the
model repo records a hash of that list).  Training continues from the published checkpoint, uses ALL
recordings (old and new) and stops by itself when the held-out lines stop
improving.  Needs HF_TOKEN.
"""
import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys
import tempfile

from huggingface_hub import HfApi, hf_hub_download

from hw.config import MAIN_WRITER

DATASET = "handwriting-fable"
MODEL = "handwriting-fable-model"


def api_and_repos():
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    if not token:
        sys.exit("HF_TOKEN is not set (GitHub: Settings > Secrets and variables > Actions; Colab: the key icon).")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    return api, f"{user}/{DATASET}", f"{user}/{MODEL}", token


def state(api, dataset, model, token):
    info = api.dataset_info(dataset)
    files = sorted(s.rfilename for s in info.siblings
                   if s.rfilename.startswith(f"raw/v1/{MAIN_WRITER}/") and s.rfilename.endswith(".json"))
    digest = hashlib.sha256("\n".join(files).encode()).hexdigest()
    trained = {}
    try:
        with open(hf_hub_download(model, "trained_on.json", token=token), encoding="utf-8") as f:
            trained = json.load(f)
    except Exception:
        pass
    return {"dataset_sha": info.sha, "lines": len(files), "lines_sha256": digest,
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
    api, dataset, model, token = api_and_repos()
    st = state(api, dataset, model, token)
    new = st["lines"] - st["trained_lines"]
    needed = args.force or (st["lines_sha256"] != st["trained_lines_sha256"] and new >= args.min_new)
    out("needed", "true" if needed else "false")
    summary(f"Aufnahmen im Dataset: {st['lines']} Zeilen, davon beim letzten Training bekannt: {st['trained_lines']}. "
            + ("Es wird neu trainiert." if needed else
               f"Noch kein Training: Es lohnt sich erst ab {args.min_new} neuen Zeilen (oder von Hand mit 'force')."))


def run(args):
    api, dataset, model, token = api_and_repos()
    st = state(api, dataset, model, token)
    py = sys.executable
    env = dict(os.environ, HF_TOKEN=token, PYTHONPATH=os.getcwd())
    work = args.out
    os.makedirs(work, exist_ok=True)
    cmd = [py, "-m", "hw.train", "--out", work, "--epochs", str(args.epochs),
           "--max-minutes", str(args.max_minutes), "--threads", str(os.cpu_count() or 2)]
    if args.resume:      # continue from the published checkpoint instead of a full run
        try:
            init = os.path.join(work, "init")
            os.makedirs(init, exist_ok=True)
            for name in ("model.pt", "meta.json"):
                path = hf_hub_download(model, f"checkpoint/{name}", token=token)
                with open(path, "rb") as src, open(os.path.join(init, name), "wb") as dst:
                    dst.write(src.read())
            cmd += ["--init", init]
        except Exception as e:
            print(f"no published checkpoint ({type(e).__name__}); starting from the pretrained base")
    subprocess.run(cmd, check=True, env=env)
    best = os.path.join(work, "best")
    image = os.path.join(work, "vergleich.png")
    subprocess.run([py, "scripts/compare.py", best, "--out", image, "--threads", str(os.cpu_count() or 2)],
                   check=True, env=env)
    marker = {"dataset": dataset, "dataset_sha": st["dataset_sha"], "lines": st["lines"],
              "lines_sha256": st["lines_sha256"],
              "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(marker, f)
    subprocess.run([py, "scripts/publish_model.py", best, "--image", image, "--marker", f.name,
                    "--message", f"Neu trainiert mit {st['lines']} erfassten Zeilen"], check=True, env=env)
    with open(os.path.join(best, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    summary(f"Modell neu trainiert und veröffentlicht: {st['lines']} erfasste Zeilen, beste Runde {meta.get('epoch')}, "
            f"Güte auf zurückgehaltenen echten Zeilen {meta.get('val_real'):.3f} (niedriger ist besser).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--force", action="store_true")
    c.add_argument("--min-new", type=int, default=20, help="retrain only when at least this many new lines exist")
    r = sub.add_parser("run")
    r.add_argument("--out", default="runs/retrain")
    r.add_argument("--epochs", type=int, default=30)
    r.add_argument("--resume", action="store_true",
                   help="continue from the published checkpoint (default: a full run from the pretrained base, "
                        "which gives the same result no matter what was trained before)")
    r.add_argument("--max-minutes", type=float, default=240)
    args = ap.parse_args()
    {"check": check, "run": run}[args.cmd](args)


if __name__ == "__main__":
    main()

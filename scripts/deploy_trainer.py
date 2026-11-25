"""Create or update the trainer Space that runs a training for the web app.

    python scripts/deploy_trainer.py

A Docker Space `<user>/handschrift-training` on the free "CPU basic" hardware.
It holds code only (hw/, scripts/, data/quality/, requirements.txt, trainer/);
recordings and models stay in the private repos and are reached with the token
the app sends when it starts a run.  Only the Space's owner can start or stop a
run.  Needs HF_TOKEN (or HUGGINGFACE_ACCESS_TOKEN) with write access.

The Space must be public: the browser talks to it directly, and a private Space
would answer the app's CORS preflight with an error.  Nothing in it is secret.
"""
import argparse
import json
import os
import shutil
import tempfile

from huggingface_hub import HfApi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

README = """---
title: Handschrift Training
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Handschrift Training

Trainiert das Handschriftmodell für die App *Handschrift*, wenn du im Tab
„Training“ auf „Training starten“ tippst. Nur der Besitzer dieses Space kann
ein Training starten oder abbrechen. Der Fortschritt steht im privaten
Modell-Repo unter `training/`; hier liegt nur Programmcode.

Schnittstelle: `POST /start`, `GET /status`, `POST /stop` (siehe `trainer/app.py`).
"""

# What the Space needs from this repository (paths relative to the repo root).
PARTS = ["hw", "scripts", "data/quality", "requirements.txt", "trainer"]
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "*.pkl", "Dockerfile")


def stage(tmp: str):
    for part in PARTS:
        src = os.path.join(ROOT, part)
        dst = os.path.join(tmp, part)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=IGNORE, dirs_exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dst) or tmp, exist_ok=True)
            shutil.copyfile(src, dst)
    shutil.copyfile(os.path.join(ROOT, "trainer", "Dockerfile"), os.path.join(tmp, "Dockerfile"))
    with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as f:
        f.write(README)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--space", default="handschrift-training")
    ap.add_argument("--dry-run", metavar="DIR", default=None,
                    help="only write what would be uploaded into DIR (no Hugging Face calls)")
    args = ap.parse_args()
    if args.dry_run:
        os.makedirs(args.dry_run, exist_ok=True)
        stage(args.dry_run)
        print(json.dumps({"staged": args.dry_run}))
        return
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    repo = args.space if "/" in args.space else f"{user}/{args.space}"
    api.create_repo(repo, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        stage(tmp)
        api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="space",
                          commit_message="Trainer aktualisiert", delete_patterns=["*"])
    sub = repo.replace("/", "-").replace("_", "-").replace(".", "-").lower()
    print(json.dumps({"space": repo, "page": f"https://huggingface.co/spaces/{repo}",
                      "runner": f"https://{sub}.hf.space"}))


if __name__ == "__main__":
    main()

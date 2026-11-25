"""Publish the web app as a static Hugging Face Space.

    python scripts/deploy_space.py

The Space holds only the app shell (HTML, CSS, JavaScript, prompts): no
recordings and no model.  Those stay in private repos and are reached with the
signed-in user's token.  `hf_oauth: true` gives the app a "Mit Hugging Face
anmelden" button.  Needs HF_TOKEN (or HUGGINGFACE_ACCESS_TOKEN) with write access.
"""
import argparse
import json
import os
import shutil
import tempfile

from huggingface_hub import HfApi

README = """---
title: Handschrift
emoji: ✍️
colorFrom: indigo
colorTo: blue
sdk: static
app_file: index.html
pinned: false
hf_oauth: true
hf_oauth_expiration_minutes: 43200
hf_oauth_scopes:
  - write-repos
---

# Handschrift

Web-App zum Erfassen der eigenen Handschrift mit dem Stift und zum Schreiben
von Text in dieser Handschrift. Die App selbst enthält keine Aufnahmen und kein
Modell; beides liegt in privaten Repos des angemeldeten Kontos.

Direkt öffnen (nicht eingebettet): `https://<konto>-handschrift.static.hf.space/index.html`
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--space", default="handschrift")
    ap.add_argument("--web", default="web")
    args = ap.parse_args()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    repo = args.space if "/" in args.space else f"{user}/{args.space}"
    api.create_repo(repo, repo_type="space", space_sdk="static", private=False, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(args.web, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("model", "*.map", ".DS_Store"))
        with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as f:
            f.write(README)
        api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="space",
                          commit_message="App aktualisiert", delete_patterns=["*"])
    sub = repo.replace("/", "-").replace("_", "-").lower()
    print(json.dumps({"space": repo, "page": f"https://huggingface.co/spaces/{repo}",
                      "app": f"https://{sub}.static.hf.space/index.html"}))


if __name__ == "__main__":
    main()

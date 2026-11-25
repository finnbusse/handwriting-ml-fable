"""Export a trained checkpoint and put it where the web app looks for it.

    python scripts/publish_model.py runs/v2/best

Uploads model.json + model.bin (and, if given, a comparison image) to the
private model repo `<user>/handwriting-fable-model` on Hugging Face.  The web
app downloads these two files after sign-in.  Needs HF_TOKEN (or
HUGGINGFACE_ACCESS_TOKEN) with write access.
"""
import argparse
import json
import os
import tempfile

from huggingface_hub import HfApi

from hw.export import export

CARD = """---
language:
- de
- en
tags:
- handwriting
license: other
---

# handwriting-fable-model

Handschriftmodell einer einzelnen Person für das Projekt *Handschrift*: Text
hinein, Stiftstriche heraus. `model.json` beschreibt die Gewichte in
`model.bin`; die Web-App lädt beide Dateien nach der Anmeldung und rechnet
vollständig im Browser.

Feingetunt aus den vortrainierten Gewichten des
[pytorch-handwriting-synthesis-toolkit](https://github.com/X-rayLaser/pytorch-handwriting-synthesis-toolkit)
(MIT-Lizenz), die auf der IAM On-Line Handwriting Database trainiert wurden.
Diese erlaubt nur nicht-kommerzielle Forschung; das Modell ist deshalb nur für
den privaten Gebrauch gedacht.
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model_dir")
    ap.add_argument("--repo", default="handwriting-fable-model")
    ap.add_argument("--image", default=None, help="comparison image to store next to the model")
    ap.add_argument("--message", default=None)
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    api = HfApi(token=token)
    repo = args.repo if "/" in args.repo else f"{api.whoami()['name']}/{args.repo}"
    api.create_repo(repo, repo_type="model", private=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        info = export(args.model_dir, tmp, "float16")
        with open(os.path.join(tmp, "model.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as f:
            f.write(CARD)
        if args.image:
            with open(args.image, "rb") as src, open(os.path.join(tmp, "vergleich.png"), "wb") as dst:
                dst.write(src.read())
        trained = manifest.get("trained", {})
        message = args.message or f"Modell aktualisiert (Runde {trained.get('epoch', '?')})"
        api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="model", commit_message=message)
    print(json.dumps({"repo": repo, "private": True, "bytes": info["bytes"], "sha256": manifest["sha256"][:16],
                      "trained": trained}, ensure_ascii=False))


if __name__ == "__main__":
    main()

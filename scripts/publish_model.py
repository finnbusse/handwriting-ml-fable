"""Export a trained checkpoint and put it where the web app looks for it.

    python scripts/publish_model.py runs/v2/best

Uploads to the private model repo `<user>/handwriting-fable-model` on
Hugging Face, as a new version `models/hw-rnn-model-<writer>-<YYYYMMDD>-<HHMMSS>/`
(see hw/models.py: models/index.json lists every version) and, as the newest,
also to the repo root:

    model.json, model.bin      what the web app downloads after sign-in
    checkpoint/model.pt, …     the PyTorch checkpoint, so that a later training
                               run can continue from here (`--init`)
    vergleich.png              optional comparison image
    trained_on.json            optional: which dataset revision the model has seen

Needs HF_TOKEN (or HUGGINGFACE_ACCESS_TOKEN) with write access.
"""
import argparse
import json
import os
import shutil
import tempfile

from hw import models
from hw.config import MAIN_WRITER
from hw.export import export
from hw.progress import HfHub

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


def prepare(model_dir: str, tmp: str, image: str | None = None, marker: str | None = None) -> tuple[dict, dict]:
    """Write everything that gets uploaded into the folder `tmp`; returns (model.json, export info)."""
    info = export(model_dir, tmp, "float16")
    with open(os.path.join(tmp, "model.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as f:
        f.write(CARD)
    os.makedirs(os.path.join(tmp, "checkpoint"))
    for name in ("model.pt", "meta.json"):
        shutil.copyfile(os.path.join(model_dir, name), os.path.join(tmp, "checkpoint", name))
    history = os.path.join(os.path.dirname(os.path.normpath(model_dir)), "history.json")
    if os.path.exists(history):
        shutil.copyfile(history, os.path.join(tmp, "checkpoint", "history.json"))
    if marker:
        shutil.copyfile(marker, os.path.join(tmp, "trained_on.json"))
    if image:
        with open(image, "rb") as src, open(os.path.join(tmp, "vergleich.png"), "wb") as dst:
            dst.write(src.read())
    return manifest, info


def folder_files(tmp: str) -> dict:
    """repo path -> local path for every file below `tmp`."""
    out = {}
    for d, _, names in os.walk(tmp):
        for n in names:
            full = os.path.join(d, n)
            out[os.path.relpath(full, tmp).replace(os.sep, "/")] = full
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model_dir")
    ap.add_argument("--repo", default="handwriting-fable-model")
    ap.add_argument("--image", default=None, help="comparison image to store next to the model")
    ap.add_argument("--marker", default=None, help="JSON file stored as trained_on.json (which recordings were used)")
    ap.add_argument("--message", default=None)
    ap.add_argument("--writer", default=None, help=f"whose hand it is (default: from the checkpoint, else {MAIN_WRITER})")
    ap.add_argument("--note", default=None, help="a short note shown with this version in the app")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
    hub = HfHub(token, model=args.repo)
    with open(os.path.join(args.model_dir, "meta.json"), encoding="utf-8") as f:
        writer = args.writer or json.load(f).get("writer") or MAIN_WRITER

    with tempfile.TemporaryDirectory() as tmp:
        manifest, info = prepare(args.model_dir, tmp, args.image, args.marker)
        trained = manifest.get("trained", {})
        message = args.message or f"Modell aktualisiert (Runde {trained.get('epoch', '?')})"
        version = models.publish(hub, tmp, writer=writer, note=args.note, message=message)
    print(json.dumps({"repo": hub.model_repo, "private": True, "version": version["id"], "bytes": info["bytes"],
                      "sha256": manifest["sha256"][:16], "trained": trained}, ensure_ascii=False))


if __name__ == "__main__":
    main()

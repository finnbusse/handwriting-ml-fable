"""The pretrained network this project starts from.

Weights: X-rayLaser/pytorch-handwriting-synthesis-toolkit, checkpoint Epoch_52
(MIT licence, see hw/assets/BASE_WEIGHTS_LICENSE), trained on IAM-OnDB.  They
are fetched once from a pinned commit and verified by checksum; nothing from
that repository is executed.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import urllib.request

COMMIT = "899e9432dfe0998ba2ef31582d11c2d5f24a5185"
URL = ("https://raw.githubusercontent.com/X-rayLaser/pytorch-handwriting-synthesis-toolkit/"
       f"{COMMIT}/checkpoints/Epoch_52/")
SHA256 = {
    "model.pt": "29dabc00f41ee0a97aea5cbf29c2a6b1ae73cc4b83864babb4fa0bd7385be73b",
}
ASSETS = os.path.join(os.path.dirname(__file__), "assets")


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ensure_base(directory: str = "artifacts/base") -> str:
    """Make sure model.pt, meta.json and stats.json exist in `directory`."""
    os.makedirs(directory, exist_ok=True)
    for name in ("model.pt", "meta.json"):
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            tmp = path + ".part"
            with urllib.request.urlopen(URL + name, timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(tmp, path)
        want = SHA256.get(name)
        if want and _sha256(path) != want:
            os.remove(path)
            raise RuntimeError(f"{name}: checksum mismatch, refusing to use the downloaded file")
    stats = os.path.join(directory, "stats.json")
    if not os.path.exists(stats):
        # measured on the base model's own output by scripts/base_stats.py
        shutil.copyfile(os.path.join(ASSETS, "base_stats.json"), stats)
    return directory

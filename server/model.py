"""The writing model: a local directory (HANDSCHRIFT_MODEL_DIR), or the newest published
version of the private model repository (HANDSCHRIFT_MODEL_REPO, read with HF_TOKEN),
cached in the data directory.  Only reads from the network."""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import threading
import time

log = logging.getLogger("handschrift")

CHECK_EVERY = 600                       # s between two looks for a newer version
FILES = ("model.pt", "meta.json")
INDEX = "models/index.json"


class HubReader:
    """Reads single files of the model repository; download() returns None for a file
    that does not exist and raises on any other failure."""

    def __init__(self, repo: str, token: str | None):
        self.repo, self.token = repo, token

    def download(self, path: str, dest_dir: str) -> str | None:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError, RemoteEntryNotFoundError

        try:
            return hf_hub_download(self.repo, path, repo_type="model", token=self.token,
                                   local_dir=dest_dir, force_download=True)
        except (EntryNotFoundError, RemoteEntryNotFoundError):
            return None

    def read(self, path: str) -> bytes | None:
        with tempfile.TemporaryDirectory() as tmp:
            got = self.download(path, tmp)
            if got is None:
                return None
            with open(got, "rb") as f:
                return f.read()


class ModelSource:
    """get() -> (version, Synthesizer) or (None, None) while no model can be had."""

    def __init__(self, cfg, reader: HubReader | None = None):
        self.cfg = cfg
        self.reader = reader or (HubReader(cfg.model_repo, cfg.hf_token) if cfg.model_repo else None)
        self.cache = os.path.join(cfg.data, "model")
        self.version, self.synth = None, None
        self.checked_at = None
        self.lock = threading.Lock()

    def _load(self, folder: str, version: str) -> None:
        from hw.sampling import Synthesizer

        synth = Synthesizer.load(folder)
        self.version, self.synth = version, synth
        log.info("model %s loaded", version)

    def get(self):
        with self.lock:
            if self.cfg.model_dir:
                if self.synth is None:
                    try:
                        self._load(self.cfg.model_dir, os.path.basename(os.path.abspath(self.cfg.model_dir)))
                    except Exception as e:                # tried again on the next call
                        log.warning("model: HANDSCHRIFT_MODEL_DIR not loadable (%s)", type(e).__name__)
            elif self.reader is not None:
                now = time.monotonic()
                if self.checked_at is None or now - self.checked_at >= CHECK_EVERY or self.synth is None:
                    self.checked_at = now
                    try:
                        self._update()
                    except Exception as e:
                        log.warning("model: repository not readable (%s); %s", type(e).__name__,
                                    f"keeping {self.version}" if self.synth else "no model yet")
                        if self.synth is None:
                            self._from_cache()
            return self.version, self.synth

    def _newest(self) -> str | None:
        raw = self.reader.read(INDEX)
        models = json.loads(raw).get("models", []) if raw else []
        return str(models[0]["id"]) if models and models[0].get("id") else None

    def _update(self) -> None:
        vid = self._newest() or "root"
        if vid == self.version and self.synth is not None:
            return
        folder = os.path.join(self.cache, vid)
        if not all(os.path.exists(os.path.join(folder, f)) for f in FILES):
            self._fetch(vid, folder)
        self._load(folder, vid)
        for other in os.listdir(self.cache):          # older versions go: one model's worth of disk
            if other != vid:
                shutil.rmtree(os.path.join(self.cache, other), ignore_errors=True)

    def _fetch(self, vid: str, folder: str) -> None:
        os.makedirs(self.cache, exist_ok=True)
        tmp = tempfile.mkdtemp(dir=self.cache, prefix=".get-")
        try:
            # the version's own checkpoint; the root copy (of the newest) for older layouts
            for prefix in ([f"models/{vid}/checkpoint/"] if vid != "root" else []) + ["checkpoint/"]:
                got = [self.reader.download(prefix + f, tmp) for f in FILES]
                if all(got):
                    for f, g in zip(FILES, got):
                        os.replace(g, os.path.join(tmp, f))
                    shutil.rmtree(os.path.join(tmp, prefix.split("/")[0]), ignore_errors=True)
                    shutil.rmtree(folder, ignore_errors=True)
                    os.replace(tmp, folder)
                    return
            raise FileNotFoundError(f"no checkpoint for {vid}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _from_cache(self) -> None:
        """Offline at start: the version cached last time."""
        if not os.path.isdir(self.cache):
            return
        for vid in sorted(os.listdir(self.cache), reverse=True):
            folder = os.path.join(self.cache, vid)
            if not vid.startswith(".") and all(os.path.exists(os.path.join(folder, f)) for f in FILES):
                self._load(folder, vid)
                return

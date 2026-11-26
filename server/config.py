"""Everything host-specific comes from the environment (server/README.md lists it)."""
from __future__ import annotations

import os
from dataclasses import dataclass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Config:
    host: str
    port: int
    public_url: str | None
    data: str
    model_dir: str | None
    model_repo: str | None
    hf_token: str | None
    key_hashes: tuple[str, ...]
    wait_seconds: float
    keep_days: float
    max_mb: float
    budget: int
    calls: int
    queue: int
    max_minutes: float
    threads: int
    batch: int
    node: str

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        hashes = tuple(h.strip().lower() for h in env("HANDSCHRIFT_KEY_HASHES", "").split(",") if h.strip())
        return cls(
            host=env("HANDSCHRIFT_HOST", "0.0.0.0"),
            port=_int("PORT", _int("HANDSCHRIFT_PORT", 8080)),
            public_url=(env("HANDSCHRIFT_PUBLIC_URL") or "").rstrip("/") or None,
            # Not ./data: started from the repository root that is the tracked data folder.
            data=os.path.abspath(env("HANDSCHRIFT_DATA") or os.path.join(HERE, "data")),
            model_dir=env("HANDSCHRIFT_MODEL_DIR") or None,
            model_repo=env("HANDSCHRIFT_MODEL_REPO") or None,
            hf_token=env("HF_TOKEN") or None,
            key_hashes=hashes,
            wait_seconds=max(0.0, _float("HANDSCHRIFT_WAIT_SECONDS", 40)),
            keep_days=_float("HANDSCHRIFT_KEEP_DAYS", 7),
            max_mb=_float("HANDSCHRIFT_MAX_MB", 500),
            budget=_int("HANDSCHRIFT_BUDGET", 30),
            # every tool call counts here, refused ones too, so that refusals are not free
            calls=_int("HANDSCHRIFT_CALLS", 2 * _int("HANDSCHRIFT_BUDGET", 30)),
            queue=_int("HANDSCHRIFT_QUEUE", 3),
            # 12,000 characters took 36-80 s on 3 threads of a shared machine; ten times that is a stuck job
            max_minutes=_float("HANDSCHRIFT_MAX_MINUTES", 10),
            threads=_int("HANDSCHRIFT_THREADS", os.cpu_count() or 1),
            # 60 pieces on 4 threads: batches of 16 took 73 ms a piece, 48 took 56, 96 took 59.
            batch=max(1, _int("HANDSCHRIFT_BATCH", 48)),
            node=env("HANDSCHRIFT_NODE", "node"),
        )

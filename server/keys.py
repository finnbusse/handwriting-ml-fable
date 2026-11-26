"""Link keys.  The link is the key: /k/<key>/mcp.  Only SHA-256 hashes are known
here, from HANDSCHRIFT_KEY_HASHES and from mcp/keys.json in the model repository
({"keys": [{"sha256": "...", "label": "...", "created": "..."}]}), so that the web
app can create and revoke links by writing that file.

A fresh key and its hash:
    python -c "import secrets,hashlib;k=secrets.token_urlsafe(32);print(k);print(hashlib.sha256(k.encode()).hexdigest())"
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time

log = logging.getLogger("handschrift")

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")          # 32 random bytes, base64url without padding
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
KEYS_FILE = "mcp/keys.json"
REFRESH = 60                                          # s between two reads of mcp/keys.json
STALE = 3600                                          # s without a good read after which its keys no longer count


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def parse_keys_file(raw: bytes) -> list[str]:
    data = json.loads(raw)
    entries = data.get("keys", []) if isinstance(data, dict) else []
    out = []
    for e in entries:
        h = str(e.get("sha256", "")).strip().lower() if isinstance(e, dict) else ""
        if HASH_RE.match(h):
            out.append(h)
    return out


class Keys:
    """`fetch()` returns the bytes of mcp/keys.json, None when there is none, and
    raises when the repository cannot be read.  The last list then stays for up to
    STALE seconds, so that a short outage locks nobody out, but a revoked key does
    not stay valid for as long as the repository is unreachable."""

    def __init__(self, env_hashes=(), fetch=None):
        self.env = [h for h in env_hashes if HASH_RE.match(h)]
        if len(self.env) != len(env_hashes):
            log.warning("keys: %d entries of HANDSCHRIFT_KEY_HASHES are not SHA-256 hex and ignored",
                        len(env_hashes) - len(self.env))
        self.fetch = fetch
        self.remote: list[str] = []
        self.read_at = None
        self.good_at = None

    def refresh(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        if self.fetch is None or (self.read_at is not None and now - self.read_at < REFRESH):
            return
        self.read_at = now
        try:
            raw = self.fetch()
            self.remote = parse_keys_file(raw) if raw else []
            self.good_at = now
        except Exception as e:                        # log no detail that could hold a secret
            if self.remote and (self.good_at is None or now - self.good_at > STALE):
                log.warning("keys: %s not readable for over %d s (%s), its %d keys dropped",
                            KEYS_FILE, STALE, type(e).__name__, len(self.remote))
                self.remote = []
            else:
                log.warning("keys: %s not readable (%s), %d keys kept", KEYS_FILE, type(e).__name__, len(self.remote))

    @property
    def configured(self) -> bool:
        return bool(self.env or self.remote)

    def check(self, key: str) -> str | None:
        """The key's hash when it is a valid key, else None.  Every known hash is
        compared, in constant time, so that timing tells nothing."""
        if not KEY_RE.match(key or ""):
            return None
        h = key_hash(key)
        hit = False
        for known in self.env + self.remote:
            hit |= hmac.compare_digest(h, known)
        return h if hit else None

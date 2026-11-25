"""Character set handling.

The pretrained base network was trained with a 79-character English alphabet.
Index 0 is reserved for "unknown character"; characters are numbered from 1.
For German we append new characters at the end, so every base character keeps
its index and the pretrained weights stay valid.
"""
from __future__ import annotations

import unicodedata

BASE_CHARSET = " !\"#%'()+,-./0123456789:;?ABCDEFGHIJKLMNOPQRSTUVWXYZ[abcdefghijklmnopqrstuvwxyz"

# Appended characters and the base character whose weights each one starts from.
EXTRA_CHARS = {
    "ä": "a", "ö": "o", "ü": "u", "Ä": "A", "Ö": "O", "Ü": "U", "ß": "B",
    "€": "E", "&": "8", "=": "-", "@": "a", "*": "+", "]": "[", "_": "-",
}

DEFAULT_CHARSET = BASE_CHARSET + "".join(EXTRA_CHARS)

# Typographic variants that are written the same way by hand.
_FOLD = {
    "„": '"', "“": '"', "”": '"', "«": '"', "»": '"',
    "‘": "'", "’": "'", "‚": ",", "´": "'", "`": "'",
    "–": "-", "—": "-", "−": "-", "…": "...",
    " ": " ", "\t": " ", "\n": " ", "{": "(", "}": ")", "<": "(", ">": ")",
    "ẞ": "ß", "|": "/", "\\": "/", "~": "-", "^": "'", "$": "S",
}


class Charset:
    def __init__(self, chars: str = DEFAULT_CHARSET):
        if len(set(chars)) != len(chars):
            raise ValueError("charset contains duplicate characters")
        self.chars = chars
        self._index = {ch: i + 1 for i, ch in enumerate(chars)}

    @property
    def size(self) -> int:
        """Alphabet size including the 'unknown' slot at index 0."""
        return len(self.chars) + 1

    def __contains__(self, ch: str) -> bool:
        return ch in self._index

    def normalize(self, text: str) -> str:
        """Map text onto characters the model knows; never drops letters silently
        except for characters that cannot be approximated at all."""
        out = []
        for ch in unicodedata.normalize("NFC", text):
            if ch in self._index:
                out.append(ch)
                continue
            ch = _FOLD.get(ch, ch)
            if all(c in self._index for c in ch):
                out.append(ch)
                continue
            # strip accents: é -> e, ç -> c ...
            base = unicodedata.normalize("NFD", ch)[0]
            if base in self._index:
                out.append(base)
        return " ".join("".join(out).split())

    def unsupported(self, text: str) -> list[str]:
        """Characters of `text` that normalize() would lose."""
        bad = []
        for ch in unicodedata.normalize("NFC", text):
            if ch.isspace() or ch in self._index:
                continue
            f = _FOLD.get(ch, ch)
            if all(c in self._index for c in f):
                continue
            if unicodedata.normalize("NFD", ch)[0] in self._index:
                continue
            bad.append(ch)
        return bad

    def encode(self, text: str) -> list[int]:
        return [self._index.get(ch, 0) for ch in text]

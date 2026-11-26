"""Plain text from what an assistant passes: the Markdown language models add by
habit goes, paragraphs and empty lines stay."""
from __future__ import annotations

import re

MAX_CHARS = 12_000
# One word is one piece and costs 60 steps per character in every pass of its batch:
# a single 400-character word took 43 s, 1,600 more than 7 minutes.  Longer words
# (in practice addresses) are cut into parts of MAX_PIECE_CHARS (layout.js: 22).
LONG_WORD = 40
PART = 22

_FENCE = re.compile(r"^\s*(```|~~~)")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_SETEXT = re.compile(r"^\s*(=+|-+)\s*$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$")
_QUOTE = re.compile(r"^\s{0,3}>\s?")
_BULLET = re.compile(r"^\s*[-*+•·▪●◦‣]\s+")
_NUMBER = re.compile(r"^\s*(\d{1,3})[.)]\s+")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BR = re.compile(r"<br\s*/?>", re.I)
_TABLE_RULE = re.compile(r"^(?=.*\|)(?=.*-)[\s|:-]+$")                 # |---|:--:|
_TABLE_ROW = re.compile(r"^\s*\|(.*)\|\s*$")
_EMPH = [
    re.compile(r"\*\*\*(\S(?:.*?\S)?)\*\*\*"),
    re.compile(r"\*\*(\S(?:.*?\S)?)\*\*"),
    re.compile(r"(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])"),
    re.compile(r"(?<!\w)__(\S(?:.*?\S)?)__(?!\w)"),
    re.compile(r"(?<!\w)_(\S(?:.*?\S)?)_(?!\w)"),
    re.compile(r"~~(\S(?:.*?\S)?)~~"),
]


def _inline(s: str) -> str:
    s = _IMAGE.sub(r"\1", s)
    s = _LINK.sub(r"\1", s)
    for rx in _EMPH:
        s = rx.sub(r"\1", s)
    return s.replace("`", "")


def plain(text: str) -> str:
    """Markdown -> the text to write.  Headings, emphasis, back ticks, links, quotes and
    rules lose their marks, list bullets become "- ", numbered lists stay, table rows
    become their cells, runs of empty lines become one."""
    lines = []
    for raw in _BR.sub("\n", str(text).replace("\r\n", "\n").replace("\r", "\n")).split("\n"):
        line = raw.replace("\t", " ").rstrip()
        if _FENCE.match(line) or _RULE.match(line) or _TABLE_RULE.match(line):
            continue
        m = _TABLE_ROW.match(line)
        if m:                                         # a table row: its cells, comma separated
            line = ", ".join(c.strip() for c in m.group(1).split("|") if c.strip())
        if _SETEXT.match(line) and lines and lines[-1]:
            continue                                  # the underline of a heading
        m = _HEADING.match(line)
        if m:
            line = m.group(1)
        line = _QUOTE.sub("", line)
        m = _BULLET.match(line)
        if m:
            line = "- " + line[m.end():]
        else:
            m = _NUMBER.match(line)
            if m:
                line = f"{m.group(1)}. " + line[m.end():]
        line = re.sub(r" {2,}", " ", _inline(line)).strip()
        if line or (lines and lines[-1]):
            lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def split_long_words(text: str) -> str:
    """Words over LONG_WORD characters become parts of PART characters."""
    def cut(m):
        w = m.group(0)
        return " ".join(w[i:i + PART] for i in range(0, len(w), PART))
    return re.sub(r"\S{%d,}" % (LONG_WORD + 1), cut, text)

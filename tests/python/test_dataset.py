"""Training data preparation (hw/dataset.py) on small synthetic inks, without
the data cache or the network.

    python -m pytest tests/python/test_dataset.py -q
"""
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

from hw import dataset
from hw.ink import Ink


def written(groups, gaps, text, kind="line"):
    """Ink of `groups` (one string per group of letters written without a
    break), separated by `gaps` (xh).  Every letter is one stroke 0.6 wide
    with 0.2 between letters, so a group's width is proportional to its
    length; `text` is what the ink is labelled with."""
    pts, x = [], 0.0
    for g, group in enumerate(groups):
        for k, _ in enumerate(group):
            pts += [[x, 0.0, 0.0], [x + 0.3, -1.0, 0.0], [x + 0.6, 0.0, 1.0]]
            x += 0.6 + (0.2 if k < len(group) - 1 else 0.0)
        if g < len(gaps):
            x += gaps[g]
    return Ink(np.array(pts), text=text, id=text, source="test", kind=kind)


class SplitWords(unittest.TestCase):
    def test_normal_line_splits(self):
        line = written(["Das", "ist", "gut"], [1.6, 1.6], "Das ist gut")
        words = dataset.split_words(line)
        self.assertEqual([w.text for w in words], ["Das", "ist", "gut"])
        self.assertEqual([len(w) for w in words], [9, 9, 9])

    def test_extra_gap_is_rejected(self):
        # written "Aufgabe # 3 morgen noch": the gap inside "#3" is wider than the
        # one before "noch", so the cuts single out the wrong gaps clearly and
        # only the widths show that the ink "3" is labelled "morgen"
        line = written(["Aufgabe", "#", "3", "morgen", "noch"], [2.0, 2.0, 2.0, 1.2], "Aufgabe #3 morgen noch")
        self.assertIsNone(dataset.split_words(line))
        self.assertIsNone(dataset.split_words(line, min_gap=0.6, ambiguous=True))

    def test_ambiguous_split_only_on_request(self):
        # the next-largest jump (inside "Haus") is nearly as wide as the word gaps
        line = written(["ein", "Ha", "us", "am", "See"], [1.6, 1.4, 1.6, 1.6], "ein Haus am See")
        self.assertIsNone(dataset.split_words(line))
        words = dataset.split_words(line, ambiguous=True)
        self.assertEqual([w.text for w in words], ["ein", "Haus", "am", "See"])
        self.assertLessEqual(dataset.word_misfit(words), dataset.WORD_FIT_MAX)


def word(text):
    return written([text], [], text, kind="word")


def first_text(pred, letters, val_fraction=0.08):
    """The first text over `letters` (by length, then alphabet) whose hash puts
    it on the held-out side."""
    import itertools

    for n in range(3, 6):
        for t in map("".join, itertools.product(letters, repeat=n)):
            if pred(t) and dataset.stable_fraction(t.lower()) < val_fraction:
                return t
    raise AssertionError("no held-out text found")


class Split(unittest.TestCase):
    def setUp(self):
        self.common = first_text(lambda t: True, "abcde")
        self.rare = first_text(lambda t: t.startswith("Ä"), "Äabcde")
        filler = [word(t) for t in ("abcde", "edcba", "bacde", "cabde", "dabce", "eabcd", "abdce", "acbde", "aebcd")]
        self.inks = filler + [word(self.common), word(self.rare)]

    def test_rare_character_is_not_held_out(self):
        train, val = dataset.split(self.inks)
        self.assertIn(self.common, [i.text for i in val])        # an ordinary word on the held-out side stays there
        self.assertIn(self.rare, [i.text for i in train])
        self.assertNotIn(self.rare, [i.text for i in val])

    def test_train_all_holds_out_nothing(self):
        train, val = dataset.split(self.inks, train_all=True)
        self.assertEqual(val, [])
        self.assertEqual(len(train), len(self.inks))


class Counting(unittest.TestCase):
    def test_points_per_char_modes(self):
        line = written(["abc", "de"], [1.6], "abc de")                  # 15 points, 5 letters, 6 characters
        w = word("abcd")                                                # 12 points, 4 letters, 4 + 1 characters
        self.assertAlmostEqual(dataset.points_per_char([line]), 3.0)
        self.assertAlmostEqual(dataset.points_per_char([line], "chars"), 2.5)
        self.assertAlmostEqual(dataset.points_per_char([w]), 3.0)
        self.assertAlmostEqual(dataset.points_per_char([w], "chars"), 2.4)

    def test_cache_key_includes_modes(self):
        calls = []

        def fake(raw, base_stats, verbose=True, calibration="letters", line_size="session"):
            calls.append((calibration, line_size))
            return [], {"calibration": calibration, "line_size": line_size}

        raw = [word("abc")]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(dataset, "calibrate", fake):
            for mode in (("letters", "session"), ("chars", "session"), ("letters", "blend"), ("chars", "session")):
                _, report = dataset.calibrate_cached(raw, {"points_per_char": 26.0}, d, *mode)
                self.assertEqual((report["calibration"], report["line_size"]), mode)
            self.assertEqual(len(os.listdir(d)), 3)
        self.assertEqual(len(calls), 3)                                 # the repeated mode came from the cache


if __name__ == "__main__":
    unittest.main()

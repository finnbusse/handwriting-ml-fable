"""Splitting text into pieces and the page layout's size correction
(hw/page.py), without a model.

    python -m unittest tests/python/test_page.py
"""
import unittest

import numpy as np

from hw import page
from hw.ink import Ink


def piece(text, x0=0.0):
    """Two little words on the baseline, 3 x-heights apart."""
    a = np.array([[x0, 0, 0], [x0 + 1, -1, 0], [x0 + 2, 0, 1]], dtype=np.float32)
    b = a.copy()
    b[:, 0] += 5.0
    return Ink(np.vstack([a, b]), text=text, kind="line", source="test")


class SplitPieces(unittest.TestCase):
    def test_no_tiny_pieces(self):
        # greedy cutting at 22 characters leaves 'an.' and 'B.' on their own
        self.assertEqual(page.split_pieces("Der Zug kommt pünktlich um acht Uhr an."),
                         [["Der Zug kommt", "pünktlich um acht Uhr an."]])
        self.assertEqual(page.split_pieces("Morgen schreiben wir die Klausur im Hörsaal B."),
                         [["Morgen schreiben wir", "die Klausur im Hörsaal B."]])
        self.assertEqual(page.split_pieces("Abc Donaudampfschifffahrt"), [["Abc Donaudampfschifffahrt"]])
        self.assertEqual(page.split_pieces("ab Donaudampfschifffahrtsgesellschaft und"),
                         [["ab Donaudampfschifffahrtsgesellschaft und"]])

    def test_short_text_stays(self):
        self.assertEqual(page.split_pieces("Ja!"), [["Ja!"]])
        self.assertEqual(page.split_pieces("Hallo\nB.\n\nOk gut"), [["Hallo"], ["B."], [], ["Ok gut"]])

    def test_limit_otherwise_kept(self):
        text = "Heute ist ein schöner Tag, und morgen wird es noch besser. Bis bald und viele Grüße!"
        for para in page.split_pieces(text):
            for p in para:
                self.assertTrue(page.SHORT_PIECE_CHARS < len(p) <= page.MAX_PIECE_CHARS, p)
        self.assertEqual(" ".join(sum(page.split_pieces(text), [])), text)


class SizeCorrection(unittest.TestCase):
    def test_scale_from_table(self):
        meta = {"size_by_bias": {"bias": [0.0, 0.4, 0.8, 1.2], "xh": [1.02, 0.86, 0.80, 0.76]}}
        got = [round(page.size_scale(meta, b), 6) for b in (-0.1, 0.0, 0.2, 0.4, 0.55, 1.2, 2.0)]
        self.assertEqual(got, [0.980392, 0.980392, 1.06383, 1.162791, 1.19403, 1.315789, 1.315789])
        self.assertEqual(page.size_scale({}, 0.4), 1.0)
        self.assertEqual(page.size_scale({"size_by_bias": {"bias": [0, 1], "xh": [0.5, 0.5]}}, 0.3), 1.5)

    def test_words_grow_gaps_stay(self):
        rows = [[piece("ab cd"), piece("ef gh")]]
        one = page.layout(rows, width=400, gap_draws=[0, 0])
        big = page.layout(rows, width=400, gap_draws=[0, 0], scale=1.25)
        self.assertEqual(len(one.words), 4)
        for w, v in zip(one.words, big.words):
            self.assertAlmostEqual(v["width"], 1.25 * w["width"], places=5)
        gaps = lambda p: [b["x"] - (a["x"] + a["width"]) for a, b in zip(p.words, p.words[1:])]
        for g1, g2 in zip(gaps(one), gaps(big)):
            self.assertAlmostEqual(g1, g2, places=5)
        # the tops of the letters are 1.25 times as far above the baseline
        self.assertAlmostEqual(float(big.ink.points[:, 1].min() - big.words[0]["y"]), -1.25, places=5)
        self.assertAlmostEqual(float(one.ink.points[:, 1].min() - one.words[0]["y"]), -1.0, places=5)


if __name__ == "__main__":
    unittest.main()

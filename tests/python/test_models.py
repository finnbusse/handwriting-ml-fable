"""Model versions in the model repo (hw/models.py), against a local folder in place
of Hugging Face: one folder per published model, the index rebuilt from what is
there, the root a copy of the newest, backfill of older models.
"""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from hw import models, progress  # noqa: E402

UTC = datetime.timezone.utc


def model_folder(tmp, name, *, sha, epoch=12, val_real=-1.9, lines=120, date=None, writer=None, extra=True):
    d = os.path.join(tmp, name)
    os.makedirs(d)
    blob = sha.encode() * 10
    with open(os.path.join(d, "model.json"), "w") as f:
        json.dump({"format": 1, "sha256": sha, "bytes": len(blob), "trained": {"epoch": epoch, "val_real": val_real}}, f)
    with open(os.path.join(d, "model.bin"), "wb") as f:
        f.write(blob)
    t = {"lines": lines, "lines_only": False, "epochs": 30}
    if date:
        t["date"] = date
    if writer:
        t["writer"] = writer
    with open(os.path.join(d, "trained_on.json"), "w") as f:
        json.dump(t, f)
    if extra:
        os.makedirs(os.path.join(d, "checkpoint"))
        with open(os.path.join(d, "checkpoint", "model.pt"), "wb") as f:
            f.write(b"pt")
        with open(os.path.join(d, "vergleich.png"), "wb") as f:
            f.write(b"png")
        with open(os.path.join(d, "README.md"), "w") as f:
            f.write("card")
    return d


class ModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.hub = progress.LocalHub(os.path.join(self.tmp, "repo"))

    def read(self, path):
        with open(os.path.join(self.hub.root, path), encoding="utf-8") as f:
            return json.load(f)

    def test_version_id(self):
        t = datetime.datetime(2026, 11, 26, 1, 48, 12, tzinfo=UTC)
        self.assertEqual(models.version_id("finn", t), "hw-rnn-model-finn-20261126-014812")
        self.assertEqual(models.version_id("Anna Lena", t), "hw-rnn-model-anna-lena-20261126-014812")
        t2 = datetime.datetime(2026, 11, 26, 2, 48, 12, tzinfo=datetime.timezone(datetime.timedelta(hours=1)))
        self.assertEqual(models.version_id("finn", t2), "hw-rnn-model-finn-20261126-014812")      # always UTC

    def test_publish_two_versions(self):
        a = model_folder(self.tmp, "a", sha="a" * 64, epoch=10, val_real=-1.8, lines=100)
        b = model_folder(self.tmp, "b", sha="b" * 64, epoch=27, val_real=-1.95321, lines=143)
        e1 = models.publish(self.hub, a, writer="finn", created=datetime.datetime(2026, 11, 25, 20, 0, 0, tzinfo=UTC))
        e2 = models.publish(self.hub, b, writer="finn", note="  mit neuen Zeilen  ", rounds=30,
                            created=datetime.datetime(2026, 11, 26, 1, 48, 12, tzinfo=UTC))
        self.assertEqual(e2, {"id": "hw-rnn-model-finn-20261126-014812", "path": "models/hw-rnn-model-finn-20261126-014812",
                              "writer": "finn", "created": "2026-11-26T01:48:12Z", "lines": 143, "lines_only": False,
                              "note": "mit neuen Zeilen", "rounds": 30, "best_round": 27, "score": -1.9532,
                              "sha256": "b" * 64, "bytes": 640})
        self.assertEqual(e1["rounds"], 30)                     # from trained_on.json "epochs" when not given
        index = self.read(models.INDEX)
        self.assertEqual(index["format"], 1)
        self.assertEqual([m["id"] for m in index["models"]], [e2["id"], e1["id"]])
        for f in ("model.json", "model.bin", "trained_on.json", "version.json", "vergleich.png", "checkpoint/model.pt"):
            self.assertTrue(self.hub.exists(f"{e2['path']}/{f}"), f)
        self.assertFalse(self.hub.exists(f"{e2['path']}/README.md"))
        self.assertEqual(self.read("model.json")["sha256"], "b" * 64)            # the root is the newest
        self.assertEqual(self.read("trained_on.json")["version"], e2["id"])
        self.assertEqual(self.read(f"{e1['path']}/trained_on.json")["version"], e1["id"])
        self.assertEqual(len(self.hub.commits), 2)                                 # one commit per publish

    def test_backfill_keeps_the_root_and_sorts(self):
        new = model_folder(self.tmp, "new", sha="c" * 64)
        models.publish(self.hub, new, writer="finn", created=datetime.datetime(2026, 11, 26, 9, 0, 0, tzinfo=UTC))
        old = model_folder(self.tmp, "old", sha="d" * 64, date="2026-11-20T10:00:00+00:00", extra=False)
        e = models.add_version(self.hub, old, note="erstes Modell")
        self.assertEqual(e["id"], "hw-rnn-model-finn-20261120-100000")
        self.assertEqual(e["note"], "erstes Modell")
        self.assertEqual(self.read("model.json")["sha256"], "c" * 64)              # an older version never replaces the root
        self.assertEqual([m["sha256"][0] for m in self.read(models.INDEX)["models"]], ["c", "d"])
        other = model_folder(self.tmp, "anna", sha="e" * 64, date="2026-11-21T08:30:00Z", writer="anna")
        self.assertEqual(models.add_version(self.hub, other)["writer"], "anna")
        nodate = model_folder(self.tmp, "nodate", sha="f" * 64)
        with self.assertRaises(ValueError):
            models.add_version(self.hub, nodate)
        e = models.add_version(self.hub, nodate, created="2026-11-19T07:00:00Z")
        self.assertEqual(e["created"], "2026-11-19T07:00:00Z")

    def test_deleted_folder_drops_out(self):
        for k, (sha, h) in enumerate([("1" * 64, 8), ("2" * 64, 9), ("3" * 64, 10)]):
            models.publish(self.hub, model_folder(self.tmp, f"m{k}", sha=sha), writer="finn",
                           created=datetime.datetime(2026, 11, 26, h, 0, 0, tzinfo=UTC))
        gone = "hw-rnn-model-finn-20261126-090000"
        shutil.rmtree(os.path.join(self.hub.root, "models", gone))                   # deleted by hand
        self.assertIn(gone, [m["id"] for m in self.read(models.INDEX)["models"]])    # the stored index still lists it ...
        index = models.rebuild_index(self.hub)
        self.assertNotIn(gone, [m["id"] for m in index["models"]])                   # ... until it is rebuilt
        models.publish(self.hub, model_folder(self.tmp, "m4", sha="4" * 64), writer="finn",
                       created=datetime.datetime(2026, 11, 26, 11, 0, 0, tzinfo=UTC))
        self.assertEqual(len(self.read(models.INDEX)["models"]), 3)

    def test_incomplete_or_damaged_versions_are_left_out(self):
        models.publish(self.hub, model_folder(self.tmp, "ok", sha="a" * 64), writer="finn",
                       created=datetime.datetime(2026, 11, 26, 8, 0, 0, tzinfo=UTC))
        models.publish(self.hub, model_folder(self.tmp, "x", sha="b" * 64), writer="finn",
                       created=datetime.datetime(2026, 11, 26, 9, 0, 0, tzinfo=UTC))
        models.publish(self.hub, model_folder(self.tmp, "y", sha="c" * 64), writer="finn",
                       created=datetime.datetime(2026, 11, 26, 10, 0, 0, tzinfo=UTC))
        os.remove(os.path.join(self.hub.root, "models", "hw-rnn-model-finn-20261126-090000", "model.bin"))
        with open(os.path.join(self.hub.root, "models", "hw-rnn-model-finn-20261126-100000", "version.json"), "w") as f:
            f.write("{not json")
        os.makedirs(os.path.join(self.hub.root, "models", "something-else"))
        with open(os.path.join(self.hub.root, "models", "something-else", "version.json"), "w") as f:
            f.write("{}")
        self.assertEqual([m["id"] for m in models.build_index(self.hub)["models"]], ["hw-rnn-model-finn-20261126-080000"])

    def test_missing_model_bin_is_refused(self):
        d = model_folder(self.tmp, "broken", sha="a" * 64)
        os.remove(os.path.join(d, "model.bin"))
        with self.assertRaises(FileNotFoundError):
            models.publish(self.hub, d, writer="finn")
        self.assertEqual(self.hub.commits, [])

    def test_list_models_script(self):
        models.publish(self.hub, model_folder(self.tmp, "a", sha="a" * 64), writer="finn", note="Test",
                       created=datetime.datetime(2026, 11, 26, 8, 0, 0, tzinfo=UTC))
        import importlib.util
        import io
        from contextlib import redirect_stdout
        spec = importlib.util.spec_from_file_location("list_models", os.path.join(ROOT, "scripts", "list_models.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        buf = io.StringIO()
        with redirect_stdout(buf):
            mod.main(["--local", self.hub.root])
        self.assertIn("hw-rnn-model-finn-20261126-080000", buf.getvalue())
        self.assertIn("Test", buf.getvalue())


if __name__ == "__main__":
    unittest.main()

"""A real (tiny) training through scripts/retrain.py run, with a local folder in
place of the model repo: start, a stop request from "the app", --resume-run, done.

Needs the prepared data cache and the base weights; skipped without them.
    HW_TEST_CACHE=... HW_TEST_BASE=... python -m unittest tests/python/test_driver_e2e.py -v
Takes about 4 minutes on one thread.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.environ.get("HW_TEST_CACHE", "/home/user/handwriting-ml-fable/data_cache")
BASE = os.environ.get("HW_TEST_BASE", "/home/user/handwriting-ml-fable/artifacts/base")
DATASET = os.environ.get("HW_TEST_DATASET", os.path.join(CACHE, "finnbusse__handwriting-fable"))


def private_cache(tmp):
    """Links to the read-only cache, so that anything new is written next to them, not into it."""
    d = os.path.join(tmp, "cache")
    os.makedirs(d)
    for name in os.listdir(CACHE):
        os.symlink(os.path.join(CACHE, name), os.path.join(d, name))
    return d


@unittest.skipUnless(os.path.isdir(CACHE) and os.path.exists(os.path.join(BASE, "model.pt")),
                     "prepared data cache / base weights not available")
class DriverEndToEnd(unittest.TestCase):
    def test_stop_resume_publish(self):
        tmp = tempfile.mkdtemp(prefix="hw-e2e-")
        hub, cache = os.path.join(tmp, "hub"), private_cache(tmp)
        env = {k: v for k, v in os.environ.items() if k not in ("HF_TOKEN", "HUGGINGFACE_ACCESS_TOKEN")}

        def cmd(out, *extra):
            return [sys.executable, os.path.join(ROOT, "scripts", "retrain.py"), "run", "--local-hub", hub,
                    "--local-dataset", DATASET, "--cache", cache, "--base", BASE, "--no-fetch",
                    "--epoch-items", "24", "--threads", "1", "--checkpoint-every", "1", "--out",
                    os.path.join(tmp, out), *extra]

        def status():
            try:
                with open(os.path.join(hub, "training", "status.json"), encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return {}

        # 1. a run of 3 epochs; once the first epoch is reported, the app asks it to stop
        p = subprocess.Popen(cmd("run1", "--epochs", "3"), env=env, cwd=ROOT,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        seen = []
        while p.poll() is None:
            st = status()
            if st.get("state") and (not seen or seen[-1] != (st["state"], st["epoch"])):
                seen.append((st["state"], st["epoch"]))
            if st.get("state") == "running" and st.get("epoch", 0) >= 1 and not os.path.exists(
                    os.path.join(hub, "training", "stop")) and ("stop", 0) not in seen:
                os.makedirs(os.path.join(hub, "training"), exist_ok=True)
                with open(os.path.join(hub, "training", "stop"), "w") as f:
                    f.write("stop")
                seen.append(("stop", 0))
            time.sleep(0.2)
        log = p.stdout.read()
        self.assertEqual(p.returncode, 0, log)
        st = status()
        self.assertEqual(st["state"], "stopped", log)
        stopped_at = st["epoch"]
        self.assertGreaterEqual(stopped_at, 2)
        self.assertEqual(st["checkpoint_epoch"], stopped_at)
        self.assertIn(("starting", 0), seen)
        self.assertIn(("running", 0), seen)
        self.assertFalse(os.path.exists(os.path.join(hub, "training", "stop")))
        for f in ("last/model.pt", "best/model.pt", "train_state.json", "history.json", "run.json"):
            self.assertTrue(os.path.exists(os.path.join(hub, "training", "checkpoint", f)), f)
        with open(os.path.join(hub, "training", "sample.png"), "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")
        self.assertFalse(os.path.exists(os.path.join(hub, "model.json")))     # a stopped run publishes nothing

        # 2. continue it for one more epoch, then it publishes
        r = subprocess.run(cmd("run2", "--resume-run", "--epochs", str(stopped_at + 1)), env=env, cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn(f"resuming after epoch {stopped_at}", r.stdout)
        st = status()
        self.assertEqual(st["state"], "done", r.stdout)
        self.assertEqual(st["resumed_from"], stopped_at)
        self.assertEqual(st["epoch"], stopped_at + 1)
        self.assertEqual(len(st["scores"]), stopped_at + 2)
        self.assertTrue(all(isinstance(s, float) for s in st["scores"]))
        self.assertEqual(st["sample_kind"], "best")
        with open(os.path.join(hub, "model.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sha256"], st["model_sha256"])
        with open(os.path.join(hub, "trained_on.json"), encoding="utf-8") as f:
            marker = json.load(f)
        self.assertEqual(marker["lines"], st["lines"])
        self.assertGreater(marker["lines"], 0)
        for f in ("model.bin", "vergleich.png", "checkpoint/model.pt"):
            self.assertTrue(os.path.exists(os.path.join(hub, f)), f)


if __name__ == "__main__":
    unittest.main()

"""Progress reporting of scripts/retrain.py run, without network and without torch training.

    python -m unittest discover -s tests/python -v
"""
import argparse
import importlib.util
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from hw import progress  # noqa: E402

spec = importlib.util.spec_from_file_location("retrain", os.path.join(ROOT, "scripts", "retrain.py"))
retrain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retrain)


class FlakyHub(progress.LocalHub):
    """A local hub whose commits can be made to fail."""

    def __init__(self, root, fail_after=None, fail_always=False):
        super().__init__(root)
        self.fail_after, self.fail_always, self.calls = fail_after, fail_always, 0

    def commit(self, files, delete=(), message=""):
        self.calls += 1
        if self.fail_always or (self.fail_after is not None and self.calls > self.fail_after):
            raise ConnectionError("hub down")
        super().commit(files, delete, message)

    def status(self):
        with open(os.path.join(self.root, progress.STATUS), encoding="utf-8") as f:
            return json.load(f)


def fake_train(epochs_done=None, stop_at=None, crash_at=None, scores=None):
    """Stands in for hw.train.main: writes what it writes, calls the hooks."""
    def main(argv, hooks=None):
        a = argparse.ArgumentParser()
        a.add_argument("--out"); a.add_argument("--epochs", type=int); a.add_argument("--resume-from")
        a.add_argument("--init")
        args, _ = a.parse_known_args(argv)
        main.argv = argv
        start, history, best, best_epoch = 0, [dict(epoch=0, score=2.0)], 2.0, 0
        if args.resume_from:
            with open(os.path.join(args.resume_from, "train_state.json")) as f:
                st = json.load(f)
            with open(os.path.join(args.resume_from, "history.json")) as f:
                history = json.load(f)
            start, best, best_epoch = st["epoch"], st["best"], st["best_epoch"]
        def sample(path):
            with open(path, "wb") as f:
                f.write(b"\x89PNG fake")
        info = dict(out=args.out, epochs=args.epochs, counts={"train_lines": 10}, history=history, sample=sample)
        if hooks.started(dict(info, epoch=start, best_epoch=best_epoch)):
            hooks.finished(dict(info, epoch=start, best_epoch=best_epoch, stopped=True))
            return dict(best_epoch=best_epoch, best=best, epoch=start, stopped=True)
        stopped = False
        e = start
        for e in range(start + 1, args.epochs + 1):
            if crash_at == e:
                raise RuntimeError("boom hf_abcdefghijklmnop")
            s = (scores or {}).get(e, 2.0 - 0.1 * e)
            history.append(dict(epoch=e, score=s, seconds=60.0))
            if s < best:
                best, best_epoch = s, e
                _write(args.out, "best", e)
            _write(args.out, "last", e)
            with open(os.path.join(args.out, "history.json"), "w") as f:
                json.dump(history, f)
            with open(os.path.join(args.out, "train_state.json"), "w") as f:
                json.dump(dict(epoch=e, epochs=args.epochs, best=best, best_epoch=best_epoch, minutes=e), f)
            if hooks.epoch(dict(info, epoch=e, best_epoch=best_epoch, minutes=float(e))) or stop_at == e:
                stopped = True
                break
        hooks.finished(dict(info, epoch=e, best_epoch=best_epoch, stopped=stopped))
        return dict(best_epoch=best_epoch, best=best, epoch=e, stopped=stopped)
    return main


def _write(out, name, epoch):
    d = os.path.join(out, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "model.pt"), "wb") as f:
        f.write(b"weights %d" % epoch)
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump({"epoch": epoch, "val_real": 1.0}, f)


def args_for(tmp, *extra):
    ns = argparse.Namespace(out=os.path.join(tmp, "work"), epochs=None, lines_only=None, resume=False,
                            resume_run=False, max_minutes=0, sample_every=1, checkpoint_every=2, runner="github",
                            run_id="run-1", threads=1, epoch_items=0, writer="finn", cache="c", base="b",
                            no_fetch=True)
    for k, v in extra:
        setattr(ns, k, v)
    return ns


class ProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.hub = FlakyHub(os.path.join(self.tmp, "hub"))

    def test_status_fields_and_one_commit(self):
        p = progress.Progress(self.hub, runner="github", epochs=30, run_id="r", lines=143, writer="finn")
        history = [dict(epoch=0, score=1.5), dict(epoch=1, score=1.2, seconds=120), dict(epoch=2, score=float("nan"),
                                                                                         seconds=180)]
        p.from_history(history, 2, 1, 5.0)
        self.assertTrue(p.publish("running", files={progress.SAMPLE: b"png"}))
        st = self.hub.status()
        for key in ("state", "runner", "started", "updated", "epoch", "epochs", "best_epoch", "scores", "minutes",
                    "minutes_left", "lines", "message", "run_id", "sample_epoch", "checkpoint_epoch"):
            self.assertIn(key, st)
        self.assertEqual(st["state"], "running")
        self.assertEqual(st["scores"], [1.5, 1.2, None])                 # NaN becomes null (valid JSON)
        self.assertEqual(st["minutes_left"], round(28 * 2.5 + 2, 1))     # recent pace 2.5 min per epoch
        self.assertEqual(len(self.hub.commits), 1)
        self.assertEqual(self.hub.commits[0]["files"], [progress.SAMPLE, progress.STATUS])

    def test_unknown_runner_and_state(self):
        p = progress.Progress(self.hub, runner="mars", epochs=3)
        self.assertEqual(p.status["runner"], "local")
        with self.assertRaises(AssertionError):
            p.publish("sleeping")

    def test_failed_upload_never_raises_unless_strict(self):
        hub = FlakyHub(os.path.join(self.tmp, "h2"), fail_always=True)
        logs = []
        p = progress.Progress(hub, runner="local", epochs=3, log=logs.append)
        self.assertFalse(p.publish("running"))
        self.assertEqual(p.failures, 1)
        self.assertIn("training continues", logs[0])
        with self.assertRaises(ConnectionError):
            p.publish("starting", strict=True)

    def test_estimate_is_capped_by_time_limit(self):
        h = [dict(epoch=e, seconds=600) for e in range(1, 4)]
        self.assertEqual(progress.estimate_minutes_left(h, 3, 30, 30.0), 272.0)
        self.assertEqual(progress.estimate_minutes_left(h, 3, 30, 30.0, max_minutes=60), 32.0)
        self.assertEqual(progress.estimate_minutes_left([], 0, 30, 0.0), 2.0)

    def test_scrub_and_messages(self):
        self.assertEqual(progress.scrub("x hf_abcdefghij1234 y"), "x hf_*** y")
        self.assertEqual(progress.scrub("tok=sekret", token="sekret"), "tok=***")

        class Resp:
            status_code = 403

        e = RuntimeError("nope")
        e.response = Resp()
        self.assertIn("darf das Modell nicht speichern", progress.german_message(e))
        self.assertIn("Verbindung", progress.german_message(ConnectionError()))
        self.assertIn("Speicher", progress.german_message(MemoryError()))
        self.assertIn("Zwischenstand", progress.german_message(progress.NoCheckpoint()))

    def test_stopwatch(self):
        flag = os.path.join(self.tmp, "stopflag")
        sw = progress.StopWatch(self.hub, local_flag=flag)
        self.assertFalse(sw.requested())
        self.assertEqual(sw.to_delete(), [])
        open(flag, "w").close()
        self.assertTrue(sw.requested())
        self.assertEqual(sw.to_delete(), [])            # a local flag is not in the repo
        os.remove(flag)
        self.hub.commit({progress.STOP: b"stop"})
        self.assertTrue(sw.requested())
        self.assertEqual(sw.to_delete(), [progress.STOP])

    def test_stopwatch_survives_hub_errors(self):
        class Broken(progress.LocalHub):
            def exists(self, path):
                raise ConnectionError()
        logs = []
        sw = progress.StopWatch(Broken(os.path.join(self.tmp, "b")), log=logs.append)
        self.assertFalse(sw.requested())
        self.assertTrue(logs)


class DriverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.hub = FlakyHub(os.path.join(self.tmp, "hub"))
        self._publish = retrain.publish
        retrain.publish = lambda *a, **k: {"sha256": "ab" * 32}
        self.hub.dataset_state = lambda writer: {"dataset": "d", "dataset_sha": "s",
                                                 "files": [f"raw/v1/{writer}/x/{i}.json" for i in range(25)],
                                                 "trained": {}}

    def tearDown(self):
        retrain.publish = self._publish

    def states(self):
        return [c["message"] for c in self.hub.commits]

    def test_full_run_reports_every_epoch_and_ends_done(self):
        args = args_for(self.tmp, ("epochs", 4))
        self.assertEqual(retrain.run(args, hub=self.hub, train_main=fake_train()), 0)
        st = self.hub.status()
        self.assertEqual(st["state"], "done")
        self.assertEqual(st["runner"], "github")
        self.assertEqual(st["lines"], 25)
        self.assertEqual(st["epoch"], 4)
        self.assertEqual(st["best_epoch"], 4)
        self.assertEqual(len(st["scores"]), 5)
        self.assertEqual(st["sample_kind"], "best")
        self.assertEqual(st["model_sha256"], "ab" * 32)
        msgs = self.states()
        self.assertTrue(msgs[0].startswith("Training: starting"))
        self.assertEqual(sum(m.startswith("Training: running") for m in msgs), 5)   # start + 4 epochs
        self.assertTrue(msgs[-2].startswith("Training: publishing"))
        # checkpoint every 2 epochs; best only when it changed
        ck = [c for c in self.hub.commits if f"{progress.CHECKPOINT}/last/model.pt" in c["files"]]
        self.assertEqual(len(ck), 2)
        self.assertTrue(all(f"{progress.CHECKPOINT}/best/model.pt" in c["files"] for c in ck))
        self.assertTrue(all(progress.SAMPLE in c["files"] for c in self.hub.commits[1:6]))

    def test_best_checkpoint_only_when_changed(self):
        args = args_for(self.tmp, ("epochs", 4))
        retrain.run(args, hub=self.hub, train_main=fake_train(scores={1: 1.0, 2: 1.5, 3: 1.6, 4: 1.7}))
        ck = [c for c in self.hub.commits if f"{progress.CHECKPOINT}/last/model.pt" in c["files"]]
        self.assertIn(f"{progress.CHECKPOINT}/best/model.pt", ck[0]["files"])
        self.assertNotIn(f"{progress.CHECKPOINT}/best/model.pt", ck[1]["files"])

    def test_stop_request_from_the_app(self):
        self.hub.commit({progress.STOP: b"old request"})           # left over: must not end the new run
        args = args_for(self.tmp, ("epochs", 10))
        train = fake_train()
        orig = self.hub.commit

        def commit(files, delete=(), message=""):
            orig(files, delete, message)
            if message.startswith("Training: running, Runde 3"):
                orig({progress.STOP: b"stop"}, message="app")         # the app's "Abbrechen"
        self.hub.commit = commit
        self.assertEqual(retrain.run(args, hub=self.hub, train_main=train), 0)
        st = self.hub.status()
        self.assertEqual(st["state"], "stopped")
        self.assertEqual(st["epoch"], 4)
        self.assertEqual(st["checkpoint_epoch"], 4)
        self.assertIn("Runde 4", st["message"])
        self.assertFalse(self.hub.exists(progress.STOP))             # removed in the same commit
        last = self.hub.commits[-1]
        self.assertIn(progress.STOP, last["delete"])
        self.assertIn(f"{progress.CHECKPOINT}/last/model.pt", last["files"])
        self.assertEqual(self.hub.commits[1]["delete"], [progress.STOP])   # the stale one went at the start

    def test_local_stop_flag(self):
        flag = os.path.join(self.tmp, "flag")
        open(flag, "w").close()
        os.environ["HW_STOP_FILE"] = flag
        try:
            retrain.run(args_for(self.tmp, ("epochs", 5)), hub=self.hub, train_main=fake_train())
        finally:
            del os.environ["HW_STOP_FILE"]
        st = self.hub.status()
        self.assertEqual(st["state"], "stopped")
        self.assertEqual(st["epoch"], 0)
        self.assertIsNone(st["checkpoint_epoch"])        # nothing to continue from: "Nochmal versuchen"

    def test_crash_sets_failed_with_reason_and_keeps_checkpoint(self):
        args = args_for(self.tmp, ("epochs", 5))
        with self.assertRaises(RuntimeError):
            retrain.run(args, hub=self.hub, train_main=fake_train(crash_at=3))
        st = self.hub.status()
        self.assertEqual(st["state"], "failed")
        self.assertEqual(st["message"], "Beim Training ist ein Fehler aufgetreten.")
        self.assertNotIn("abcdefghijklmnop", st["error"])
        self.assertEqual(st["checkpoint_epoch"], 2)
        self.assertIn(f"{progress.CHECKPOINT}/last/model.pt", self.hub.commits[-1]["files"])

    def test_failed_status_uploads_do_not_stop_training(self):
        hub = FlakyHub(os.path.join(self.tmp, "hub2"), fail_after=1)      # only "starting" gets through
        hub.dataset_state = self.hub.dataset_state
        self.assertEqual(retrain.run(args_for(self.tmp, ("epochs", 3)), hub=hub, train_main=fake_train()), 0)
        self.assertGreaterEqual(hub.calls, 6)

    def test_first_status_must_arrive(self):
        hub = FlakyHub(os.path.join(self.tmp, "hub3"), fail_always=True)
        train = fake_train()
        with self.assertRaises(ConnectionError):
            retrain.run(args_for(self.tmp, ("epochs", 3)), hub=hub, train_main=train)
        self.assertFalse(hasattr(train, "argv"))                           # training never started

    def test_resume_run_continues_from_the_checkpoint(self):
        args = args_for(self.tmp, ("epochs", 6), ("lines_only", True))
        retrain.run(args, hub=self.hub, train_main=fake_train(stop_at=4))
        self.assertEqual(self.hub.status()["state"], "stopped")
        args2 = args_for(self.tmp, ("resume_run", True))
        args2.out = os.path.join(self.tmp, "work2")
        train = fake_train()
        self.assertEqual(retrain.run(args2, hub=self.hub, train_main=train), 0)
        self.assertIn("--resume-from", train.argv)
        self.assertIn("--lines-only", train.argv)                          # options of the run that is continued
        self.assertEqual(train.argv[train.argv.index("--epochs") + 1], "6")
        st = self.hub.status()
        self.assertEqual(st["state"], "done")
        self.assertEqual(st["resumed_from"], 4)
        self.assertEqual(st["epoch"], 6)
        self.assertEqual(len(st["scores"]), 7)                              # the curve goes on

    def test_resume_without_checkpoint_fails_plainly(self):
        with self.assertRaises(progress.NoCheckpoint):
            retrain.run(args_for(self.tmp, ("resume_run", True)), hub=self.hub, train_main=fake_train())
        st = self.hub.status()
        self.assertEqual(st["state"], "failed")
        self.assertIn("Zwischenstand", st["message"])

    def test_lines_only_default_and_flags(self):
        train = fake_train()
        retrain.run(args_for(self.tmp, ("epochs", 1)), hub=self.hub, train_main=train)
        self.assertEqual("--lines-only" in train.argv, retrain.LINES_ONLY)
        parsed = []
        orig = retrain.run
        retrain.run = lambda a, hub=None: parsed.append(a)
        try:
            retrain.main(["run", "--lines-only"])
            retrain.main(["run", "--all-data"])
            retrain.main(["run", "--local-hub", os.path.join(self.tmp, "x")])
        finally:
            retrain.run = orig
        self.assertEqual([p.lines_only for p in parsed], [True, False, None])


if __name__ == "__main__":
    unittest.main()

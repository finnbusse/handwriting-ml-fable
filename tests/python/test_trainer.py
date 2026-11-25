"""The trainer Space's service, with Hugging Face replaced: owner check, one job
at a time, stop, status, CORS, and that the token never shows up in a log.

The HTTP part needs fastapi (+ httpx for its TestClient); without them only the
job logic is tested.
"""
import os
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.environ["HW_TRAINER_NO_APP"] = "1"
from trainer import jobs  # noqa: E402

OWNER_TOKEN = "hf_ownerTOKEN1234567890"
OTHER_TOKEN = "hf_otherTOKEN1234567890"

# A stand-in for scripts/retrain.py: prints its environment's token (which must be
# scrubbed), then waits for the stop flag or 20 s; "fail" in its options fails it.
FAKE = r"""
import os, sys, time
print("token is", os.environ.get("HF_TOKEN"), flush=True)
print("args", " ".join(sys.argv[1:]), flush=True)
if "--epochs" in sys.argv and sys.argv[sys.argv.index("--epochs") + 1] == "13":
    print("Fehler: Beim Training ist ein Fehler aufgetreten.", flush=True)
    sys.exit(1)
end = time.time() + 20
while time.time() < end:
    if os.path.exists(os.environ["HW_STOP_FILE"]):
        print("stopped", flush=True)
        sys.exit(0)
    time.sleep(0.05)
"""


def fake_whoami(token):
    if token == OWNER_TOKEN:
        return "Finn"
    if token == OTHER_TOKEN:
        return "someone"
    raise RuntimeError("401")


def make_runner(tmp):
    calls = []

    def whoami(token):
        calls.append(token)
        return fake_whoami(token)

    def command(options, run_id, workdir):
        return [sys.executable, "-c", FAKE] + jobs.build_command(options, run_id, workdir)[3:]

    r = jobs.Runner("finn", whoami=whoami, command=command, workdir=tmp,
                    env=dict(os.environ, HF_TOKEN="hf_storedSECRET999999"))
    r.whoami_calls = calls
    return r


def wait(cond, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    raise AssertionError("timed out")


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.r = make_runner(self.tmp)

    def tearDown(self):
        if self.r.running():
            self.r.job.proc.kill()
            self.r.job.proc.wait()

    def test_owner_check(self):
        with self.assertRaises(jobs.Refused) as c:
            self.r.check(None)
        self.assertEqual(c.exception.kind, "auth")
        with self.assertRaises(jobs.Refused) as c:
            self.r.check("hf_badbadbadbad")
        self.assertEqual(c.exception.kind, "auth")
        with self.assertRaises(jobs.Refused) as c:
            self.r.check(OTHER_TOKEN)
        self.assertEqual(c.exception.kind, "owner")
        self.assertEqual(self.r.check(OWNER_TOKEN), "Finn")          # case does not matter
        self.r.check(OWNER_TOKEN)
        self.assertEqual(self.r.whoami_calls.count(OWNER_TOKEN), 1)  # remembered for a while
        nobody = jobs.Runner("", whoami=fake_whoami)
        with self.assertRaises(jobs.Refused) as c:
            nobody.check(OWNER_TOKEN)
        self.assertEqual(c.exception.kind, "owner")

    def test_options(self):
        self.assertEqual(jobs.parse_options({"epochs": 12, "lines_only": True, "sample_every": 2, "resume": True,
                                             "junk": 1}),
                         {"epochs": 12, "lines_only": True, "sample_every": 2, "resume": True})
        self.assertEqual(jobs.parse_options(None), {})
        for bad in ({"epochs": 0}, {"epochs": "3"}, {"epochs": True}, {"lines_only": "yes"}, {"sample_every": -1},
                    [1]):
            with self.assertRaises(jobs.Refused):
                jobs.parse_options(bad)
        cmd = jobs.build_command({"epochs": 12, "lines_only": False, "sample_every": 2, "resume": True}, "r1", "/w")
        self.assertIn("--all-data", cmd)
        self.assertIn("--resume-run", cmd)
        self.assertEqual(cmd[cmd.index("--runner") + 1], "space")
        self.assertEqual(cmd[cmd.index("--epochs") + 1], "12")
        self.assertNotIn("--lines-only", jobs.build_command({}, "r1", "/w"))
        self.assertNotIn("--epochs", jobs.build_command({}, "r1", "/w"))          # the driver's default

    def test_start_one_at_a_time_stop_and_log(self):
        job = self.r.start(OWNER_TOKEN, {"epochs": 3})
        with self.assertRaises(jobs.Refused) as c:
            self.r.start(OWNER_TOKEN, {})
        self.assertEqual(c.exception.kind, "busy")
        with self.assertRaises(jobs.Refused):
            self.r.stop(OTHER_TOKEN)
        wait(lambda: any(l.startswith("args") for l in job.log))
        self.r.stop(OWNER_TOKEN)
        wait(lambda: job.exit_code is not None)
        self.assertEqual(job.exit_code, 0)
        self.assertIn("stopped", job.log)
        log = "\n".join(job.log)
        self.assertNotIn(OWNER_TOKEN, log)
        self.assertNotIn("storedSECRET", log)                   # a stored token is not passed on either
        self.assertIn("token is ***", log)
        self.assertFalse(os.path.exists(job.stop_file))
        st = self.r.status(authorized=False)
        self.assertFalse(st["running"])
        self.assertNotIn("log", st["job"])
        st = self.r.status(authorized=True)
        self.assertIn("args", "\n".join(st["job"]["log"]))
        with self.assertRaises(jobs.Refused) as c:
            self.r.stop(OWNER_TOKEN)
        self.assertEqual(c.exception.kind, "idle")
        for name in os.listdir(self.tmp):                        # nothing with the token on disk
            p = os.path.join(self.tmp, name)
            if os.path.isfile(p):
                with open(p, errors="ignore") as f:
                    self.assertNotIn(OWNER_TOKEN, f.read())

    def test_failed_job_message(self):
        job = self.r.start(OWNER_TOKEN, {"epochs": 13})
        wait(lambda: job.exit_code is not None)
        self.assertEqual(job.exit_code, 1)
        self.assertEqual(self.r.status(True)["job"]["message"], "Beim Training ist ein Fehler aufgetreten.")
        job2 = self.r.start(OWNER_TOKEN, {"epochs": 2})           # a new run is possible afterwards
        self.assertNotEqual(job.run_id, job2.run_id)

    def test_force_stop(self):
        job = self.r.start(OWNER_TOKEN, {})
        wait(lambda: job.log)
        self.r.stop(OWNER_TOKEN, force=True)
        wait(lambda: job.exit_code is not None)
        self.assertNotEqual(job.exit_code, None)

    def test_defaults_come_from_the_driver(self):
        d = jobs.retrain_defaults()
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import retrain
        self.assertEqual(d["epochs"], retrain.EPOCHS)
        self.assertEqual(d["lines_only"], retrain.LINES_ONLY)
        self.assertEqual(d["sample_every"], retrain.SAMPLE_EVERY)
        self.assertEqual(d["writer"], retrain.MAIN_WRITER)


try:
    from fastapi.testclient import TestClient
    from trainer import app as app_mod
except Exception:  # pragma: no cover
    TestClient = None


@unittest.skipIf(TestClient is None, "fastapi/httpx not installed")
class HttpTest(unittest.TestCase):
    ORIGIN = "https://finn-handschrift.static.hf.space"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.r = make_runner(self.tmp)
        self.app = app_mod.create_app(owner="finn", runner=self.r,
                                      defaults={"epochs": 30, "lines_only": False, "sample_every": 1})
        self.c = TestClient(self.app)

    def tearDown(self):
        if self.r.running():
            self.r.job.proc.kill()
            self.r.job.proc.wait()

    def h(self, token=None, origin=ORIGIN):
        out = {"Origin": origin}
        if token:
            out["Authorization"] = f"Bearer {token}"
        return out

    def test_origin(self):
        self.assertEqual(app_mod.app_origin("Finn_B"), "https://finn-b-handschrift.static.hf.space")

    def test_status_public_and_private(self):
        r = self.c.get("/status", headers=self.h())
        self.assertEqual(r.status_code, 200)
        j = r.json()
        self.assertEqual(j["running"], False)
        self.assertEqual(j["defaults"]["epochs"], 30)
        self.assertFalse(j["authorized"])
        self.assertEqual(r.headers["access-control-allow-origin"], self.ORIGIN)
        self.assertTrue(self.c.get("/status", headers=self.h(OWNER_TOKEN)).json()["authorized"])
        self.assertFalse(self.c.get("/status", headers=self.h(OTHER_TOKEN)).json()["authorized"])

    def test_cors(self):
        pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
        r = self.c.options("/start", headers=dict(self.h(), **pre))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], self.ORIGIN)
        r = self.c.options("/start", headers=dict(self.h(origin="http://localhost:8123"), **pre))
        self.assertEqual(r.headers["access-control-allow-origin"], "http://localhost:8123")
        r = self.c.options("/start", headers=dict(self.h(origin="https://evil.example"), **pre))
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_start_refusals_and_stop(self):
        self.assertEqual(self.c.post("/start", headers=self.h(), json={}).status_code, 401)
        r = self.c.post("/start", headers=self.h(OTHER_TOKEN), json={})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "owner")
        self.assertEqual(self.c.post("/start", headers=self.h(OWNER_TOKEN), json={"epochs": 0}).status_code, 400)
        r = self.c.post("/start", headers=self.h(OWNER_TOKEN), json={"epochs": 3, "lines_only": True})
        self.assertEqual(r.status_code, 200, r.text)
        run_id = r.json()["run_id"]
        self.assertEqual(self.c.post("/start", headers=self.h(OWNER_TOKEN), json={}).status_code, 409)
        j = self.c.get("/status", headers=self.h(OWNER_TOKEN)).json()
        self.assertTrue(j["running"])
        self.assertEqual(j["job"]["run_id"], run_id)
        self.assertEqual(j["job"]["options"], {"epochs": 3, "lines_only": True})
        self.assertEqual(self.c.post("/stop", headers=self.h(OTHER_TOKEN)).status_code, 403)
        self.assertEqual(self.c.post("/stop", headers=self.h(OWNER_TOKEN)).status_code, 200)
        wait(lambda: not self.c.get("/status").json()["running"])
        j = self.c.get("/status", headers=self.h(OWNER_TOKEN)).json()
        self.assertEqual(j["job"]["exit_code"], 0)
        self.assertTrue(j["job"]["stop_requested"])
        self.assertNotIn(OWNER_TOKEN, str(j))
        self.assertEqual(self.c.post("/stop", headers=self.h(OWNER_TOKEN)).status_code, 409)


if __name__ == "__main__":
    unittest.main()

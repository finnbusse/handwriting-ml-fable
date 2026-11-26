"""The GitHub workflow that the Training tab starts: its inputs reach
scripts/retrain.py run as the right options, and odd input values cannot
become shell code.  Runs the workflow's own step script with a stub `python`.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "retrain.yml")

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


@unittest.skipIf(yaml is None or not shutil.which("bash"), "needs PyYAML and bash")
class WorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(WORKFLOW, encoding="utf-8") as f:
            cls.wf = yaml.safe_load(f)
        cls.steps = cls.wf["jobs"]["retrain"]["steps"]

    def step(self, name_part):
        return next(s for s in self.steps if name_part in s.get("name", ""))

    def test_inputs(self):
        inputs = self.wf[True]["workflow_dispatch"]["inputs"]       # YAML reads "on" as True
        self.assertEqual(set(inputs), {"force", "epochs", "lines_only", "sample_every", "resume", "note"})
        self.assertIs(inputs["force"]["default"], True)
        self.assertEqual(inputs["lines_only"]["options"], ["standard", "ja", "nein"])
        self.assertIn("inputs.resume", self.step("Gibt es genug")["run"])   # a resume never waits for 20 new lines

    def run_step(self, **env):
        step = self.step("Trainieren")
        tmp = tempfile.mkdtemp()
        stub = os.path.join(tmp, "python")
        with open(stub, "w") as f:
            f.write('#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT"\n')
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        out = os.path.join(tmp, "args")
        e = {"PATH": tmp + os.pathsep + os.environ["PATH"], "OUT": out}
        e.update({k: "" for k in step["env"]})
        e.update(env)
        subprocess.run(["bash", "-e", "-c", step["run"]], env=e, check=True, cwd=tmp, capture_output=True)
        with open(out) as f:
            return f.read().split("\n")[:-1]

    def test_defaults_pass_nothing(self):
        self.assertEqual(self.run_step(IN_LINES_ONLY="standard", IN_RESUME="false"), ["scripts/retrain.py", "run"])

    def test_all_options(self):
        args = self.run_step(IN_EPOCHS="12", IN_LINES_ONLY="ja", IN_SAMPLE_EVERY="5", IN_RESUME="true")
        self.assertEqual(args, ["scripts/retrain.py", "run", "--epochs", "12", "--lines-only", "--sample-every", "5",
                                "--resume-run"])
        self.assertIn("--all-data", self.run_step(IN_LINES_ONLY="nein"))

    def test_note_is_one_argument(self):
        args = self.run_step(IN_NOTE='mit "neuen" Zeilen; $(id) `x`')
        self.assertEqual(args, ["scripts/retrain.py", "run", "--note", 'mit "neuen" Zeilen; $(id) `x`'])

    def test_odd_values_are_dropped_not_run(self):
        args = self.run_step(IN_EPOCHS="12; touch pwned", IN_SAMPLE_EVERY="$(id)", IN_LINES_ONLY="ja; x")
        self.assertEqual(args, ["scripts/retrain.py", "run"])


if __name__ == "__main__":
    unittest.main()

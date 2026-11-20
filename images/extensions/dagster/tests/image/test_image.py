# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Dagster image tests — run INSIDE the image under test, against its real dbt (01 §7.1 tests 1–2).

Run with `run.sh <image>`, which mounts the repo read-only at /src. Nothing here is mocked: every
parse is the image's own `dbt` through the image's own `os_projects.py --parse`, and the verdict
cache test drives the image's own `repo-sync.sh` against a local git repository.

1. generate → parse: every generator golden (os-ui/tabs/data/lib/dbt/fixtures, the generator's
   real output) parses with exit 0 and dbt writes a manifest stamped with the image's dbt-core.
   Negative twins: the pre-#139 duplicate-rule shape and a bad ref are REFUSED, with dbt's text.
2. verdict cache: a failing sha is parsed once across several passes; status.json carries dbt's
   own error; a new good commit is parsed once and becomes `current`.
"""
import glob
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest

SRC = os.environ.get("SRC", "/src")
APP = os.environ.get("APP_DIR", "/opt/dagster/app")
GOLDENS = sorted(glob.glob(os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures/*.golden.json")))
DUPLICATE_RULE = os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures/duplicate-rule.golden.json")
DBT_CORE = importlib.metadata.version("dbt-core")


def write_tree(files, root):
    for path, content in files.items():
        full = os.path.join(root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(content)


def parse(root):
    p = subprocess.run(["python3", os.path.join(APP, "os_projects.py"), "--parse", root],
                       capture_output=True, text=True, timeout=300)
    return p.returncode, p.stdout + p.stderr


def pre_fix_duplicate(files):
    """The live pre-#139 shape: the same not_null test written twice on one column."""
    out = dict(files)
    key = next(k for k in out if k.endswith("schema.yml") and "data_tests" in out[k])
    out[key] = out[key].replace("- not_null\n", "- not_null\n" + re.search(r"( *)- not_null\n", out[key]).group(1) + "- not_null\n", 1)
    return out


def bad_ref(files):
    out = dict(files)
    out["models/gold/gold_broken.sql"] = "select * from {{ ref('silver_gone') }}\n"
    return out


def load(path):
    with open(path) as fh:
        return json.load(fh)


class GenerateThenParse(unittest.TestCase):
    def test_goldens_present(self):
        self.assertGreaterEqual(len(GOLDENS), 9, GOLDENS)
        for shape in ("sweep-full", "sweep-labels", "sweep-element", "live-q3-count-metric"):
            self.assertTrue(any(g.endswith(f"/{shape}.golden.json") for g in GOLDENS), shape)
        self.assertIn(DUPLICATE_RULE, GOLDENS, "the duplicate-rule golden is part of the set")

    def test_every_golden_parses_in_the_image(self):
        for g in GOLDENS:
            with self.subTest(golden=os.path.basename(g)), tempfile.TemporaryDirectory() as d:
                files = load(g)
                write_tree(files, d)
                code, out = parse(d)
                skipped = files.get("os/skipped.yml")
                self.assertEqual(code, 0, f"dbt parse refused {g} (skipped: {skipped}):\n{out[-2000:]}")
                manifest = load(os.path.join(d, "target/manifest.json"))
                # Written by the real dbt: a fake parse cannot produce this stamp.
                self.assertEqual(manifest["metadata"]["dbt_version"], DBT_CORE)
                models = [n for n in manifest["nodes"].values() if n["resource_type"] == "model"]
                self.assertTrue(models, "the manifest holds the generated models")

    def test_readme_names_the_dbt_and_dsi_versions_this_image_carries(self):
        readme = load(os.path.join(SRC, "os-ui/tabs/data/lib/dbt/fixtures/metrics-semantic-layer.golden.json"))["README.md"]
        # dbt-core 1.12 reads the semantic layer through MetricFlow's own semantic interfaces.
        mf = importlib.metadata.version("metricflow")
        self.assertIn(f"`metricflow {mf}` (its `metricflow_semantic_interfaces`)", readme)
        self.assertIn(f"(= dbt-core {DBT_CORE})", readme)

    def test_pre_fix_duplicate_rule_is_refused_with_dbts_text(self):
        with tempfile.TemporaryDirectory() as d:
            write_tree(pre_fix_duplicate(load(DUPLICATE_RULE)), d)
            code, out = parse(d)
            self.assertNotEqual(code, 0)
            self.assertRegex(out, r"dbt found two data_tests with the name")

    def test_bad_ref_is_refused_with_dbts_text(self):
        with tempfile.TemporaryDirectory() as d:
            write_tree(bad_ref(load(DUPLICATE_RULE)), d)
            code, out = parse(d)
            self.assertNotEqual(code, 0)
            self.assertRegex(out, r"silver_gone")


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def commit_tree(work, files):
    for entry in os.listdir(work):
        if entry != ".git":
            p = os.path.join(work, entry)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    write_tree(files, work)
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", "c", cwd=work)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=work, capture_output=True, text=True).stdout.strip()


class VerdictCache(unittest.TestCase):
    INTERVAL = 1

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.base = os.path.join(self.tmp, "remote")
        self.checkout = os.path.join(self.tmp, "checkout")
        os.makedirs(self.base)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.work)
        git("init", "-q", "-b", "main", cwd=self.work)
        self.log_path = os.path.join(self.tmp, "repo-sync.log")
        self.proc = None

    def tearDown(self):
        if self.proc:
            self.proc.terminate()
            self.proc.wait(10)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def publish(self):
        bare = os.path.join(self.base, "sales.git")
        if not os.path.isdir(bare):
            subprocess.run(["git", "clone", "-q", "--bare", self.work, bare], check=True)
        else:
            git("push", "-q", "-f", bare, "main:main", cwd=self.work)

    def start(self, **extra):
        env = {
            "PATH": os.environ["PATH"], "HOME": self.tmp,
            "REPO_SYNC_ENABLED": "true", "POD_NAME": "agentic-os-dagster-user-deployments-test",
            "REPO_SYNC_INDEX_URL": "", "REPO_SYNC_DOMAINS": "sales",
            "REPO_SYNC_GIT_BASE": "file://" + self.base, "REPO_SYNC_CHECKOUT": self.checkout,
            "REPO_SYNC_INTERVAL": str(self.INTERVAL), "REPO_SYNC_STATUS_PORT": "18089",
            "DAGSTER_RELOAD_LOCATION": "", "APP_DIR": APP,
            **extra,
        }
        self.log = open(self.log_path, "w")
        self.proc = subprocess.Popen(["sh", os.path.join(APP, "repo-sync.sh")], env=env,
                                     stdout=self.log, stderr=subprocess.STDOUT)

    def log_text(self):
        with open(self.log_path) as fh:
            return fh.read()

    def status(self):
        try:
            return load(os.path.join(self.checkout, "status.json"))["domains"].get("sales") or {}
        except (OSError, ValueError, KeyError):
            return {}

    def wait_for(self, pred, timeout=240):
        end = time.time() + timeout
        while time.time() < end:
            s = self.status()
            if pred(s):
                return s
            time.sleep(0.5)
        self.fail(f"timed out; status={self.status()}\nlog:\n{self.log_text()[-3000:]}")

    def wait_passes(self, n):
        """Wait until status.json has been re-aggregated on n further passes (checkedAt moves)."""
        seen, last = 0, self.status().get("checkedAt")
        end = time.time() + 120 + n * 30
        while seen < n and time.time() < end:
            time.sleep(0.3)
            now = self.status().get("checkedAt")
            if now and now != last:
                seen, last = seen + 1, now
        self.assertEqual(seen, n, "repo-sync kept passing")

    def test_failed_sha_is_parsed_once_and_status_carries_dbts_error(self):
        golden = load(DUPLICATE_RULE)
        bad = commit_tree(self.work, pre_fix_duplicate(golden))
        self.publish()
        self.start()
        s = self.wait_for(lambda s: s.get("head") == bad and s.get("error"))
        self.wait_passes(3)
        log = self.log_text()
        self.assertEqual(log.count(f"parsing {bad}"), 1, f"the failed sha was re-parsed:\n{log}")
        s = self.status()
        self.assertIsNone(s["current"])
        self.assertIn("dbt found two data_tests with the name", s["error"], "dbt's own text, verbatim")
        self.assertIn("dbt found two data_tests", s.get("errorSummary") or "", "the one-line summary")
        self.assertIn("dbt found two data_tests", log, "the summary is in the pod log")

        good = commit_tree(self.work, golden)
        self.publish()
        s = self.wait_for(lambda s: s.get("current") == good)
        self.assertIsNone(s["error"])
        self.wait_passes(2)
        log = self.log_text()
        self.assertEqual(log.count(f"parsing {good}"), 1, log)
        self.assertEqual(log.count(f"parsing {bad}"), 1, log)
        self.assertTrue(os.path.isfile(os.path.join(self.checkout, "sales/current/target/manifest.json")))

    def test_a_timeout_is_retried_never_cached_as_a_refusal(self):
        """A parse that did not finish (timeout here; an OOM kill behaves the same) must not pin a
        good commit as failed: no verdict file, an honest 'did not finish' status, and a re-parse."""
        good = commit_tree(self.work, load(DUPLICATE_RULE))
        self.publish()
        self.start(REPO_SYNC_PARSE_TIMEOUT="0.5")
        s = self.wait_for(lambda s: s.get("head") == good and "did not finish" in (s.get("error") or ""))
        self.assertIsNone(s["current"])
        end = time.time() + 120
        while self.log_text().count(f"parsing {good}") < 2 and time.time() < end:
            time.sleep(0.5)
        self.assertGreaterEqual(self.log_text().count(f"parsing {good}"), 2, "a timed-out sha is parsed again")
        self.assertFalse(os.path.exists(os.path.join(self.checkout, ".verdicts", "sales", good + ".json")),
                         "a timeout is never cached as dbt's verdict")


if __name__ == "__main__":
    unittest.main(verbosity=2)

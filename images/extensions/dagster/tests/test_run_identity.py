# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""WP-15 unit tests for the run-identity half of os_projects.py (no Dagster needed).

FEATURE:    A Dagster run acts as its owner only after os-ui's /start accepted its run grant; the
            Trino password reaches dbt only then, under a DBT_ENV_SECRET_ name.
USER STORY: As a data owner I want a run that has no grant, or whose grant os-ui refuses, to stop
            before dbt starts, and nothing secret to sit in the run's environment before that.
ARCHITECTURE:
  - A stdlib HTTP server stands in for os-ui's route here (the route itself, the real Dagster,
    Trino 476 and OPA are tests/dagster/run-identity.int.test.ts).
  - Identity mode is ON exactly when the chart mounted the runner's password file.
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_projects as osp  # noqa: E402

SHA = "a" * 40


class _Route(http.server.BaseHTTPRequestHandler):
    calls = []
    answer = (200, {"principal": "alice", "grant_rev": "7"})

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length") or 0)
        _Route.calls.append({"path": self.path, "auth": self.headers.get("authorization"), "body": json.loads(self.rfile.read(n) or b"{}")})
        status, body = _Route.answer
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # quiet
        pass


class RunIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), _Route)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        _Route.calls.clear()
        _Route.answer = (200, {"principal": "alice", "grant_rev": "7"})
        self.dir = tempfile.mkdtemp()
        self.pw = os.path.join(self.dir, "password")
        self.tok = os.path.join(self.dir, "token")
        with open(self.tok, "w") as f:
            f.write("projected-sa-token\n")
        self.env = {"OS_TRINO_PASSWORD_FILE": self.pw, "OS_RUN_TOKEN_FILE": self.tok, "OS_CODE_TOKEN_FILE": self.tok, "OS_UI_URL": self.url}
        self.tags = {"os/run_grant": "rg_ds_00112233445566778899aabb", "os/principal": "alice", "os/domain": "sales"}

    def _pw(self):
        with open(self.pw, "w") as f:
            f.write("s3cret-runner-pw\n")

    def test_off_without_the_password_file_and_nothing_is_called(self):
        self.assertFalse(osp.run_identity_enabled(self.env))
        self.assertEqual(osp.run_identity_env("r1", self.tags, self.env), {})
        self.assertEqual(_Route.calls, [])

    def test_on_a_granted_run_gets_its_principal_and_the_password_only_after_start(self):
        self._pw()
        self.assertTrue(osp.run_identity_enabled(self.env))
        env = osp.run_identity_env("r1", self.tags, self.env)
        self.assertEqual(env, {"OS_PRINCIPAL": "alice", "DBT_ENV_SECRET_TRINO_PASSWORD": "s3cret-runner-pw"})
        self.assertEqual(len(_Route.calls), 1)
        c = _Route.calls[0]
        self.assertEqual(c["path"], "/api/runtime/run-grants/rg_ds_00112233445566778899aabb/start")
        self.assertEqual(c["auth"], "Bearer projected-sa-token")
        self.assertEqual(c["body"], {"run_id": "r1"})

    def test_the_principal_comes_from_os_ui_not_from_the_run_tags(self):
        self._pw()
        tags = {**self.tags, "os/principal": "mallory"}
        _Route.answer = (200, {"principal": "alice", "grant_rev": "7"})
        with self.assertRaises(osp.UnauthorisedLaunch) as e:
            osp.run_identity_env("r1", tags, self.env)
        self.assertIn("unauthorised launch", str(e.exception))

    def test_no_grant_tag_fails_without_calling_os_ui(self):
        self._pw()
        with self.assertRaises(osp.UnauthorisedLaunch) as e:
            osp.run_identity_env("r1", {"os/principal": "alice"}, self.env)
        self.assertIn("no run grant", str(e.exception))
        self.assertEqual(_Route.calls, [])

    def test_a_refusal_carries_os_ui_reason(self):
        self._pw()
        _Route.answer = (403, {"error": "unauthorised_launch", "reason": "the run pins another commit than the grant"})
        with self.assertRaises(osp.UnauthorisedLaunch) as e:
            osp.run_identity_env("r1", self.tags, self.env)
        self.assertIn("another commit", str(e.exception))

    def test_os_ui_unreachable_fails_closed(self):
        self._pw()
        env = {**self.env, "OS_UI_URL": "http://127.0.0.1:1"}
        with self.assertRaises(osp.UnauthorisedLaunch):
            osp.run_identity_env("r1", self.tags, env)

    def test_finish_posts_the_run_id_with_the_code_server_token(self):
        self.assertTrue(osp.finish_run_grant("r9", {"os/run_grant": "rg_std_ffeeddccbbaa998877665544"}, self.env))
        self.assertEqual(_Route.calls[0]["path"], "/api/runtime/run-grants/rg_std_ffeeddccbbaa998877665544/finish")
        self.assertEqual(_Route.calls[0]["body"], {"run_id": "r9"})
        self.assertFalse(osp.finish_run_grant("r9", {}, self.env), "a run without a grant has nothing to finish")


class ScheduleGrants(unittest.TestCase):
    YML = """
version: 1
schedules:
  - dataset: ds_1
    name: silver_x
    select: silver_x+
    cron: "0 * * * *"
    timezone: UTC
    principal: alice
    enabled: true
    run_grant: rg_std_0123456789abcdef01234567
"""

    def test_the_standing_grant_id_becomes_the_run_tag(self):
        s = osp.parse_schedules(self.YML)[0]
        self.assertEqual(s.run_grant, "rg_std_0123456789abcdef01234567")
        tags = osp.schedule_tags("sales", s, SHA, f"sales={SHA}")
        self.assertEqual(tags["os/run_grant"], "rg_std_0123456789abcdef01234567")

    def test_a_malformed_grant_id_is_dropped(self):
        s = osp.parse_schedules(self.YML.replace("rg_std_0123456789abcdef01234567", "x; rm -rf"))[0]
        self.assertEqual(s.run_grant, "")
        self.assertNotIn("os/run_grant", osp.schedule_tags("sales", s, SHA, f"sales={SHA}"))


if __name__ == "__main__":
    unittest.main()

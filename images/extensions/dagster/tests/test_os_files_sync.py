# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""The Drive-sync job's call into os-ui (`os_files_sync.py`), against a real local HTTP server.

FEATURE:    `tick` POSTs to os-ui's runtime route with the run pod's token and turns anything but a clean
            pass into a failed run — an unreachable os-ui, a refusal, a source that failed. A paused source
            that os-ui skipped is not a failure.
USER STORY: As a drive owner I want Dagster to show a failed run when my drive's sync did not happen, never a
            green one.
ARCHITECTURE: pure module (no dagster import); the real run through Dagster is the monitoring harness
            (tests/monitoring/drive-sync.int.test.ts). `test_names_agree_with_os_ui` keeps the job and schedule
            names equal to the constants os-ui's panel reads.
"""
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import os_files_sync as fs  # noqa: E402


class Os(BaseHTTPRequestHandler):
    seen = []
    status = 200
    body = {"trigger": "schedule", "results": [], "failed": 0}

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("content-length") or 0)
        Os.seen.append({"path": self.path, "auth": self.headers.get("authorization"), "body": json.loads(self.rfile.read(n) or b"{}")})
        raw = json.dumps(Os.body).encode()
        self.send_response(Os.status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):  # noqa: D401
        pass


@pytest.fixture()
def env():
    Os.seen, Os.status, Os.body = [], 200, {"trigger": "schedule", "results": [], "failed": 0}
    srv = HTTPServer(("127.0.0.1", 0), Os)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    d = tempfile.mkdtemp()
    tok = os.path.join(d, "token")
    open(tok, "w").write("sa-token-not-a-secret\n")
    yield {"OS_UI_URL": f"http://127.0.0.1:{srv.server_port}", "OS_RUN_TOKEN_FILE": tok}
    srv.shutdown()


def test_posts_to_the_runtime_route_with_the_bearer(env):
    Os.body = {"trigger": "schedule", "results": [{"sourceId": "s1", "status": "ok", "added": 2}], "failed": 0}
    out = fs.tick(env)
    assert out["results"][0]["added"] == 2
    assert Os.seen == [{"path": "/api/runtime/files-sync", "auth": "Bearer sa-token-not-a-secret", "body": {"trigger": "schedule"}}]


def test_a_skipped_paused_source_is_not_a_failure(env):
    Os.body = {"trigger": "schedule", "results": [{"sourceId": "s1", "status": "skipped", "reason": "paused: the owner is deactivated"}], "failed": 0}
    assert fs.tick(env)["failed"] == 0


def test_a_failed_source_fails_the_run_with_its_reason(env):
    Os.body = {"trigger": "schedule", "failed": 1, "results": [{"sourceId": "s1", "status": "ok"}, {"sourceId": "s2", "status": "failed", "reason": "Microsoft Graph answered 503."}]}
    with pytest.raises(fs.SyncPassFailed, match="s2.*Graph answered 503"):
        fs.tick(env)


def test_a_refusal_fails_the_run(env):
    Os.status, Os.body = 403, {"error": "forbidden", "reason": "OPA: files_sync_run"}
    with pytest.raises(fs.SyncPassFailed, match="403.*files_sync_run"):
        fs.tick(env)
    Os.status, Os.body = 503, {"error": "store_not_loaded", "reason": "Connected sources could not be loaded"}
    with pytest.raises(fs.SyncPassFailed, match="store_not_loaded"):
        fs.tick(env)


def test_unreachable_os_ui_or_no_token_fails_closed(env):
    with pytest.raises(fs.SyncPassFailed, match="could not be reached"):
        fs.tick({**env, "OS_UI_URL": "http://127.0.0.1:1"})
    with pytest.raises(fs.SyncPassFailed, match="no run token"):
        fs.tick({**env, "OS_RUN_TOKEN_FILE": "/nonexistent/token"})
    assert Os.seen == []


def test_a_malformed_answer_is_a_failure_not_a_pass(env):
    Os.body = {"unexpected": True}
    with pytest.raises(fs.SyncPassFailed, match="did not say"):
        fs.tick(env)


def test_the_schedule_runs_only_where_the_token_exists(env):
    assert fs.schedule_default_running(env) is True
    assert fs.schedule_default_running({**env, "OS_RUN_TOKEN_FILE": "/nonexistent/token"}) is False


def test_cron_is_configurable_and_validated():
    assert fs.cron({}) == "*/15 * * * *"
    assert fs.cron({"OS_FILES_SYNC_CRON": "0 * * * *"}) == "0 * * * *"
    assert fs.cron({"OS_FILES_SYNC_CRON": "not a cron"}) == "*/15 * * * *"


def test_names_agree_with_os_ui():
    ts = open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "os-ui", "core", "infra", "drive-sync-health.ts"), encoding="utf-8").read()
    assert re.search(rf"DRIVE_SYNC_JOB = '{fs.JOB_NAME}'", ts)
    assert re.search(rf"DRIVE_SYNC_SCHEDULE = '{fs.SCHEDULE_NAME}'", ts)

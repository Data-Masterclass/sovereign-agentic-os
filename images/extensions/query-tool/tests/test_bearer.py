# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Service-bearer auth tests for the query-tool HTTP handlers. Stdlib only:

    python3 -m unittest discover -s images/extensions/query-tool/tests

Proves the defense-in-depth chokepoint behind the NetworkPolicies:
  * SERVICE_BEARER_TOKEN set  -> /query + /execute require a matching Bearer (401 else)
  * SERVICE_BEARER_TOKEN unset -> no check (fail-open by design; netpol is primary)
  * /health is always open (never carries the token).
Runtime deps (mcp / starlette / trino) come from the SHARED `_stubs` module — the same
stubs every module in this directory uses, so one discovery pass is honest.
"""
import asyncio
import unittest

import _stubs

STUB = _stubs.install()

import app  # noqa: E402  (imports against the shared stubs)


class _Req:
    """Just enough of a starlette Request: case-insensitive .headers + async .json()."""

    def __init__(self, body, headers=None):
        self._body = body
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}

    async def json(self):
        return self._body


def _ok_query(sql, principal=None, schema=None):
    return {"engine": "trino", "columns": [], "rows": [], "row_count": 0}


class BearerHelperTests(unittest.TestCase):
    def setUp(self):
        self._saved = _stubs.snapshot_app(app)

    def tearDown(self):
        _stubs.restore_app(app, self._saved)

    def test_absent_env_allows_any_request(self):
        app.SERVICE_BEARER_TOKEN = ""
        self.assertTrue(app._bearer_ok(_Req({}, {})))
        self.assertTrue(app._bearer_ok(_Req({}, {"authorization": "Bearer nonsense"})))

    def test_valid_token_passes(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        self.assertTrue(app._bearer_ok(_Req({}, {"authorization": "Bearer s3cr3t"})))
        self.assertTrue(app._bearer_ok(_Req({}, {"authorization": "bearer s3cr3t"})))

    def test_missing_or_wrong_token_rejected(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        self.assertFalse(app._bearer_ok(_Req({}, {})))
        self.assertFalse(app._bearer_ok(_Req({}, {"authorization": "s3cr3t"})))
        self.assertFalse(app._bearer_ok(_Req({}, {"authorization": "Bearer wrong"})))


class HandlerAuthTests(unittest.TestCase):
    def setUp(self):
        self._saved = _stubs.snapshot_app(app)
        app.run_query = _ok_query

    def tearDown(self):
        # Restore EVERY patched knob, not just the token: `run_query` left replaced is what made
        # this module's order matter to the budget suite under one discovery pass.
        _stubs.restore_app(app, self._saved)

    def test_query_401_without_token_when_enabled(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        res = asyncio.run(app.http_query(_Req({"sql": "select 1"}, {})))
        self.assertEqual(res.status_code, 401)

    def test_query_passes_with_valid_token(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        res = asyncio.run(app.http_query(
            _Req({"sql": "select 1"}, {"authorization": "Bearer s3cr3t"})))
        self.assertEqual(res.status_code, 200)

    def test_query_passes_without_header_when_disabled(self):
        app.SERVICE_BEARER_TOKEN = ""  # fail-open: no header needed
        res = asyncio.run(app.http_query(_Req({"sql": "select 1"}, {})))
        self.assertEqual(res.status_code, 200)

    def test_execute_401_without_token_when_enabled(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        res = asyncio.run(app.http_execute(_Req(
            {"sql": "DROP TABLE x", "principal": "lena"}, {})))
        self.assertEqual(res.status_code, 401)

    async def _health(self):
        # /health must never require the token (probes carry none).
        return await app.health(_Req({}, {}))

    def test_health_always_open_even_when_enabled(self):
        app.SERVICE_BEARER_TOKEN = "s3cr3t"
        res = asyncio.run(self._health())
        self.assertEqual(res.status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)

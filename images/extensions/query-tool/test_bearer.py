# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Service-bearer auth tests for the query-tool HTTP handlers. Stdlib only:

    python3 -m pytest -q test_bearer.py   (or: python3 test_bearer.py)

Proves the defense-in-depth chokepoint behind the NetworkPolicies:
  * SERVICE_BEARER_TOKEN set  -> /query + /execute require a matching Bearer (401 else)
  * SERVICE_BEARER_TOKEN unset -> no check (fail-open by design; netpol is primary)
  * /health is always open (never carries the token).
Runtime deps (mcp / starlette / trino) are stubbed exactly like the concurrency test.
"""
import asyncio
import sys
import types
import unittest


def _install_stubs():
    class _FastMCP:
        def __init__(self, *a, **k):
            pass

        def tool(self, *a, **k):
            return lambda fn: fn

        def custom_route(self, *a, **k):
            return lambda fn: fn

        def run(self, *a, **k):
            pass

    mcp_mod = types.ModuleType("mcp")
    mcp_server = types.ModuleType("mcp.server")
    mcp_fastmcp = types.ModuleType("mcp.server.fastmcp")
    mcp_fastmcp.FastMCP = _FastMCP
    mcp_mod.server = mcp_server
    mcp_server.fastmcp = mcp_fastmcp
    sys.modules.setdefault("mcp", mcp_mod)
    sys.modules.setdefault("mcp.server", mcp_server)
    sys.modules.setdefault("mcp.server.fastmcp", mcp_fastmcp)

    class _JSONResponse:
        def __init__(self, content, status_code=200):
            self.content = content
            self.status_code = status_code

    st_mod = types.ModuleType("starlette")
    st_req = types.ModuleType("starlette.requests")
    st_req.Request = object
    st_res = types.ModuleType("starlette.responses")
    st_res.JSONResponse = _JSONResponse
    sys.modules.setdefault("starlette", st_mod)
    sys.modules.setdefault("starlette.requests", st_req)
    sys.modules.setdefault("starlette.responses", st_res)

    class _TrinoUserError(Exception):
        pass

    trino_mod = types.ModuleType("trino")
    trino_exc = types.ModuleType("trino.exceptions")
    trino_exc.TrinoUserError = _TrinoUserError
    trino_dbapi = types.ModuleType("trino.dbapi")
    trino_dbapi.connect = lambda **k: None
    trino_mod.exceptions = trino_exc
    trino_mod.dbapi = trino_dbapi
    sys.modules.setdefault("trino", trino_mod)
    sys.modules.setdefault("trino.exceptions", trino_exc)
    sys.modules.setdefault("trino.dbapi", trino_dbapi)


_install_stubs()

import app  # noqa: E402  (imports cleanly against the stubs)


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
        app.run_query = _ok_query

    def tearDown(self):
        app.SERVICE_BEARER_TOKEN = ""

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

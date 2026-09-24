# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Concurrency smoke test for the query-tool HTTP handlers. Stdlib only — run with:

    python3 test_app_concurrency.py

(needs Python >= 3.10 to import app.py's `str | None` annotations; the image
pins python:3.12.)

Proves the scalability fix: the blocking Trino execution is offloaded with
`asyncio.to_thread`, so two in-flight statements OVERLAP instead of serializing
on the event loop (the audit found effective concurrency of ~1). The runtime
deps (mcp / starlette / trino) are stubbed in sys.modules before importing app.
"""
import asyncio
import sys
import time
import types
import unittest


# ---- Stub the runtime-only deps so `import app` works without the image env. ----
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
    """Just enough of a starlette Request: an async .json()."""

    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


SLEEP = 0.2


def _slow_query(sql, principal=None, schema=None):
    time.sleep(SLEEP)  # a blocking Trino round-trip stand-in
    return {"engine": "trino", "columns": [], "rows": [], "row_count": 0}


def _slow_execute(sql, principal, schema):
    time.sleep(SLEEP)
    return {"ok": True, "rowsAffected": 1}


class ConcurrencyTests(unittest.TestCase):
    def test_two_queries_overlap(self):
        app.run_query = _slow_query

        async def go():
            t0 = time.monotonic()
            r1, r2 = await asyncio.gather(
                app.http_query(_Req({"sql": "select 1"})),
                app.http_query(_Req({"sql": "select 2"})),
            )
            return time.monotonic() - t0, r1, r2

        elapsed, r1, r2 = asyncio.run(go())
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        # Serialized execution would take >= 2*SLEEP; overlapped stays well under.
        self.assertLess(elapsed, 2 * SLEEP * 0.9, "queries must interleave, not serialize")

    def test_execute_overlaps_with_query(self):
        app.run_query = _slow_query
        app.run_execute = _slow_execute
        write = {
            "sql": "CREATE OR REPLACE TABLE iceberg.personal_lena.bronze_x AS SELECT 1 AS a",
            "principal": "lena", "uid": "lena", "domains": ["sales"], "role": "creator",
        }

        async def go():
            t0 = time.monotonic()
            r1, r2 = await asyncio.gather(
                app.http_execute(_Req(write)),
                app.http_query(_Req({"sql": "select 1"})),
            )
            return time.monotonic() - t0, r1, r2

        elapsed, r1, r2 = asyncio.run(go())
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertLess(elapsed, 2 * SLEEP * 0.9, "a long write must not block reads")

    def test_execute_still_guards_before_the_thread(self):
        app.run_execute = _slow_execute

        async def go():
            return await app.http_execute(_Req({
                "sql": "DROP SCHEMA iceberg.sales",  # off the allowlist
                "principal": "lena", "uid": "lena", "domains": ["sales"], "role": "creator",
            }))

        res = asyncio.run(go())
        self.assertEqual(res.status_code, 400, "the guard still rejects before any execution")


if __name__ == "__main__":
    unittest.main(verbosity=2)

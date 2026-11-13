# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""The READ budget of `query_data` (B4-review E-1). Stdlib only — run with:

    python3 test_query_budget.py

(needs Python >= 3.10 for app.py's `str | None` annotations; the image pins 3.12.)

What this pins, and why each half matters:
  * `connect_kwargs` passes BOTH `request_timeout` (the client gives up) and the
    `query_max_run_time` session property (TRINO abandons the statement). Before this,
    `query_data` had neither, so os-ui's 8 s AbortSignal ended os-ui's WAIT while the
    query kept running on the cluster — an orphan nobody was waiting for.
  * the client timeout is never SHORTER than Trino's ceiling, because a shorter one
    orphans the query, which is the bug.
  * a read fetches at most `QUERY_MAX_ROWS + 1` rows and reports `truncated: true`
    with the limit — measured from the extra row, never guessed, and never a silently
    clipped result set.
  * writes stay unbounded unless EXECUTE_MAX_RUN_TIME is set, because a full-refresh
    sync legitimately runs for minutes.
"""
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

    class _TrinoConnectionError(Exception):
        pass

    trino_mod = types.ModuleType("trino")
    trino_exc = types.ModuleType("trino.exceptions")
    trino_exc.TrinoUserError = _TrinoUserError
    trino_exc.TrinoConnectionError = _TrinoConnectionError
    trino_dbapi = types.ModuleType("trino.dbapi")
    CONNECTS = []

    class _Cursor:
        description = [("a",), ("b",)]

        def __init__(self, rows):
            self._rows = rows

        def execute(self, sql):
            self.sql = sql

        def fetchmany(self, n):
            took, self._rows = self._rows[:n], self._rows[n:]
            return took

        def fetchall(self):
            took, self._rows = self._rows, []
            return took

    class _Conn:
        rows = []

        def cursor(self):
            return _Cursor(list(_Conn.rows))

    def _connect(**kwargs):
        CONNECTS.append(kwargs)
        return _Conn()

    trino_dbapi.connect = _connect
    trino_mod.exceptions = trino_exc
    trino_mod.dbapi = trino_dbapi
    sys.modules.setdefault("trino", trino_mod)
    sys.modules.setdefault("trino.exceptions", trino_exc)
    sys.modules.setdefault("trino.dbapi", trino_dbapi)
    return CONNECTS, _Conn


CONNECTS, FakeConn = _install_stubs()

import app  # noqa: E402
from execute_guard import connect_kwargs  # noqa: E402


BASE = dict(host="trino", port=8080, catalog="iceberg", http_scheme="http", default_user="query-agent")


class ConnectKwargs(unittest.TestCase):
    def test_both_halves_are_passed(self):
        k = connect_kwargs("amir", "sales", request_timeout=65, max_run_time="60s", **BASE)
        self.assertEqual(k["request_timeout"], 65)
        self.assertEqual(k["session_properties"], {"query_max_run_time": "60s"})
        self.assertEqual(k["user"], "amir", "the session user is still the caller's principal")

    def test_omitted_when_unbounded(self):
        k = connect_kwargs("amir", "sales", **BASE)
        self.assertNotIn("request_timeout", k)
        self.assertNotIn("session_properties", k)

    def test_timeout_without_a_run_time_is_still_allowed(self):
        k = connect_kwargs(None, "sales", request_timeout=10, **BASE)
        self.assertEqual(k["request_timeout"], 10)
        self.assertNotIn("session_properties", k)
        self.assertEqual(k["user"], "query-agent", "no principal falls back to the tool's user")


class DurationParsing(unittest.TestCase):
    def test_shapes(self):
        self.assertEqual(app._seconds("60s"), 60)
        self.assertEqual(app._seconds("5m"), 300)
        self.assertEqual(app._seconds("1h"), 3600)
        self.assertEqual(app._seconds("90"), 90)
        self.assertEqual(app._seconds("1500ms"), 1)

    def test_malformed_never_raises(self):
        self.assertEqual(app._seconds("later", fallback=42), 42)
        self.assertEqual(app._seconds("", fallback=7), 7)
        self.assertEqual(app._seconds(None, fallback=7), 7)


class ReadIsBounded(unittest.TestCase):
    def setUp(self):
        CONNECTS.clear()
        FakeConn.rows = [(1, 2), (3, 4)]
        self._rows, app.QUERY_MAX_ROWS = app.QUERY_MAX_ROWS, 10
        self._rt, app.QUERY_MAX_RUN_TIME = app.QUERY_MAX_RUN_TIME, "60s"

    def tearDown(self):
        app.QUERY_MAX_ROWS = self._rows
        app.QUERY_MAX_RUN_TIME = self._rt

    def test_a_read_carries_both_ceilings(self):
        app.run_query("select a, b from t", principal="amir", schema="sales")
        self.assertEqual(len(CONNECTS), 1)
        self.assertEqual(CONNECTS[0]["session_properties"], {"query_max_run_time": "60s"})
        self.assertEqual(CONNECTS[0]["request_timeout"], 65)

    def test_the_client_never_gives_up_before_trino_does(self):
        # A shorter client timeout would ORPHAN the query on the cluster — the defect.
        app.run_query("select a, b from t", principal="amir")
        self.assertGreaterEqual(CONNECTS[0]["request_timeout"], app._seconds(app.QUERY_MAX_RUN_TIME))

    def test_under_the_limit_is_not_truncated(self):
        out = app.run_query("select a, b from t", principal="amir")
        self.assertEqual(out["row_count"], 2)
        self.assertNotIn("truncated", out)

    def test_over_the_limit_truncates_and_says_so(self):
        FakeConn.rows = [(i, i) for i in range(25)]
        out = app.run_query("select a, b from t", principal="amir")
        self.assertEqual(out["row_count"], 10, "exactly the limit is returned")
        self.assertTrue(out["truncated"])
        self.assertEqual(out["row_limit"], 10)
        self.assertIn("QUERY_MAX_ROWS", out["message"])
        self.assertIn("not a sample", out["message"], "the caller must not read it as a sample")

    def test_exactly_the_limit_is_not_called_truncated(self):
        FakeConn.rows = [(i, i) for i in range(10)]
        out = app.run_query("select a, b from t", principal="amir")
        self.assertEqual(out["row_count"], 10)
        self.assertNotIn("truncated", out, "the +1 row is what measures truncation, so N == limit is exact")


class WriteBudget(unittest.TestCase):
    def setUp(self):
        CONNECTS.clear()
        FakeConn.rows = [(1,)]

    def test_unbounded_by_default(self):
        self.assertEqual(app.EXECUTE_MAX_RUN_TIME, "", "a write ceiling is opt-in")
        app.run_execute("create table iceberg.sales.x as select 1", "amir", "sales")
        self.assertNotIn("session_properties", CONNECTS[0], "a long sync must not be aborted by a guess")

    def test_opt_in_ceiling_is_honoured(self):
        prior, app.EXECUTE_MAX_RUN_TIME = app.EXECUTE_MAX_RUN_TIME, "900s"
        try:
            app.run_execute("create table iceberg.sales.x as select 1", "amir", "sales")
            self.assertEqual(CONNECTS[0]["session_properties"], {"query_max_run_time": "900s"})
        finally:
            app.EXECUTE_MAX_RUN_TIME = prior


if __name__ == "__main__":
    unittest.main(verbosity=2)

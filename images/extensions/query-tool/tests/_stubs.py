# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""ONE set of runtime stubs for every query-tool test module.

FEATURE:    `app.py` imports `mcp`, `starlette` and `trino`, none of which are installed outside
            the image. Each test module used to install its OWN stubs with
            `sys.modules.setdefault(...)` and then `import app`. Run one module at a time that
            works; run them together and it does not: the FIRST module to import wins every
            `setdefault`, `app` is bound to that module's fake `trino.dbapi.connect`, and the
            later modules' recording lists stay empty. That is the Part F isolation defect (F-4) —
            7 of the 12 budget tests failed under a single `unittest discover` pass and all 12
            passed per file.
USER STORY: As a maintainer I want `python3 -m unittest discover -s images/extensions/query-tool/tests`
            to be the one honest command, so CI does not have to run the files one by one to hide
            an ordering bug.
ARCHITECTURE:
  - The stubs are installed exactly ONCE, by whichever module imports first, and every module
    then shares them — so there is only ever one `trino.dbapi.connect` and one `app`.
  - State that a test mutates lives on the shared handle (`connects`, `rows`), never in a module
    global a second module cannot reach. `reset()` returns the handle to its as-installed state
    and is what `setUp` calls, so test ORDER cannot leak either.
  - `app`'s own module-level knobs (`run_query`, `run_execute`, `SERVICE_BEARER_TOKEN`,
    `QUERY_MAX_ROWS`, `QUERY_MAX_RUN_TIME`, `EXECUTE_MAX_RUN_TIME`) are monkeypatched by several
    suites; `patch_app`/`restore_app` snapshot and restore them around a test so a patch cannot
    outlive the module that made it.
"""
import os
import sys
import types

# The package dir (`..`) holds app.py / execute_guard.py. Discovery puts THIS directory on
# sys.path, not its parent, so the import target has to be added explicitly — the same line
# `images/extensions/dagster/tests` uses.
_PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
if _PKG not in sys.path:
    sys.path.insert(0, _PKG)


class TrinoStub:
    """The shared fake Trino: records every `connect(**kwargs)` and serves `rows`."""

    def __init__(self):
        self.connects = []
        self.rows = []
        self.description = [("a",), ("b",)]

    def reset(self, rows=None, description=None):
        """Back to as-installed. Call it from `setUp`, never rely on the previous test."""
        self.connects.clear()
        self.rows = list(rows or [])
        self.description = description or [("a",), ("b",)]
        return self


_STUB = None


def _build_cursor(stub):
    class _Cursor:
        def __init__(self, rows):
            self._rows = rows
            self.description = stub.description
            self.sql = None

        def execute(self, sql):
            self.sql = sql

        def fetchmany(self, n):
            took, self._rows = self._rows[:n], self._rows[n:]
            return took

        def fetchall(self):
            took, self._rows = self._rows, []
            return took

    return _Cursor


def install():
    """Install the stubs (once) and return the shared handle. Safe to call from every module."""
    global _STUB
    if _STUB is not None:
        return _STUB
    stub = TrinoStub()

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

    class _JSONResponse:
        def __init__(self, content, status_code=200):
            self.content = content
            self.status_code = status_code

    st_mod = types.ModuleType("starlette")
    st_req = types.ModuleType("starlette.requests")
    st_req.Request = object
    st_res = types.ModuleType("starlette.responses")
    st_res.JSONResponse = _JSONResponse

    class TrinoUserError(Exception):
        pass

    class TrinoConnectionError(Exception):
        pass

    _Cursor = _build_cursor(stub)

    class _Conn:
        def cursor(self):
            return _Cursor(list(stub.rows))

    def _connect(**kwargs):
        stub.connects.append(kwargs)
        return _Conn()

    trino_mod = types.ModuleType("trino")
    trino_exc = types.ModuleType("trino.exceptions")
    trino_exc.TrinoUserError = TrinoUserError
    trino_exc.TrinoConnectionError = TrinoConnectionError
    trino_dbapi = types.ModuleType("trino.dbapi")
    trino_dbapi.connect = _connect
    trino_mod.exceptions = trino_exc
    trino_mod.dbapi = trino_dbapi

    # ASSIGN, never `setdefault`: a setdefault is what let the first importer win and left every
    # later module's recorder dead. There is exactly one installer now, so assignment is safe.
    for name, mod in (
        ("mcp", mcp_mod),
        ("mcp.server", mcp_server),
        ("mcp.server.fastmcp", mcp_fastmcp),
        ("starlette", st_mod),
        ("starlette.requests", st_req),
        ("starlette.responses", st_res),
        ("trino", trino_mod),
        ("trino.exceptions", trino_exc),
        ("trino.dbapi", trino_dbapi),
    ):
        sys.modules[name] = mod

    stub.user_error = TrinoUserError
    stub.connection_error = TrinoConnectionError
    _STUB = stub
    return stub


_APP_KNOBS = (
    "run_query",
    "run_execute",
    "SERVICE_BEARER_TOKEN",
    "QUERY_MAX_ROWS",
    "QUERY_MAX_RUN_TIME",
    "EXECUTE_MAX_RUN_TIME",
)


def snapshot_app(app):
    """The module-level knobs the suites monkeypatch, so `restore_app` can put them all back."""
    return {k: getattr(app, k) for k in _APP_KNOBS if hasattr(app, k)}


def restore_app(app, saved):
    for k, v in saved.items():
        setattr(app, k, v)

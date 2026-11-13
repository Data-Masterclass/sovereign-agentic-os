# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Concurrency smoke test for the query-tool HTTP handlers. Stdlib only — run with:

    python3 -m unittest discover -s images/extensions/query-tool/tests

(needs Python >= 3.10 to import app.py's `str | None` annotations; the image
pins python:3.12.)

Proves the scalability fix: the blocking Trino execution is offloaded with
`asyncio.to_thread`, so two in-flight statements OVERLAP instead of serializing
on the event loop (the audit found effective concurrency of ~1). The runtime
deps (mcp / starlette / trino) come from the SHARED `_stubs` module, so this file's
monkeypatches of `app.run_query` / `app.run_execute` cannot leak into another module
(setUp snapshots them, tearDown puts them back).
"""
import asyncio
import time
import unittest

import _stubs

STUB = _stubs.install()

import app  # noqa: E402  (imports against the shared stubs)


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
    def setUp(self):
        # These tests REPLACE app.run_query / app.run_execute with slow fakes. Restoring them is
        # what lets the budget suite — which calls the REAL run_query — share this process.
        STUB.reset()
        self._saved = _stubs.snapshot_app(app)

    def tearDown(self):
        _stubs.restore_app(app, self._saved)

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

# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Unit tests for the data-runner's ingest logic (guards + replace/append modes).

The network/service deps (boto3/pyiceberg) are stubbed in sys.modules BEFORE importing
app.py, and the network-touching seams (_s3_client/_catalog/_read_to_arrow) are
monkeypatched with fakes — so these run without a cluster (PyArrow, the ingest reader,
is a real dep but the reader seam is patched, so no file/engine is actually touched):

    python3 -m pytest -q test_app.py
"""
import json
import sys
import types
import unittest
from unittest import mock

# ---- Stub the runtime-only deps so `import app` works without the image env.
# PyArrow is a REAL dependency now (the ingest reader; DuckDB was removed), so it is
# NOT stubbed — but _read_to_arrow is monkeypatched in every test, so these unit
# tests still never touch a real file or the network. ----
for name in ("boto3",):
    sys.modules.setdefault(name, types.ModuleType(name))
botocore = types.ModuleType("botocore")
botocore_config = types.ModuleType("botocore.config")
botocore_config.Config = object
botocore.config = botocore_config
sys.modules.setdefault("botocore", botocore)
sys.modules.setdefault("botocore.config", botocore_config)
pyiceberg = types.ModuleType("pyiceberg")
pyiceberg_catalog = types.ModuleType("pyiceberg.catalog")
pyiceberg_catalog.load_catalog = lambda *a, **k: None
pyiceberg.catalog = pyiceberg_catalog
sys.modules.setdefault("pyiceberg", pyiceberg)
sys.modules.setdefault("pyiceberg.catalog", pyiceberg_catalog)

import app  # noqa: E402  (imports cleanly against the stubs)


class FakeField:
    def __init__(self, name, type_):
        self.name = name
        self.type = type_


class FakeArrow:
    """Just enough of a pyarrow Table: schema (iterable of fields) + num_rows."""

    def __init__(self, rows=3):
        self.schema = [FakeField("id", "int64"), FakeField("amount", "double")]
        self.num_rows = rows


class FakeTable:
    def __init__(self, log, label):
        self.log = log
        self.label = label

    def append(self, arrow):
        self.log.append(("append", self.label, arrow.num_rows))


class FakeCatalog:
    def __init__(self, log, exists=False):
        self.log = log
        self.exists = exists

    def create_namespace_if_not_exists(self, ns):
        self.log.append(("ensure_ns", ns))

    def table_exists(self, ident):
        return self.exists

    def drop_table(self, ident):
        self.log.append(("drop", ident))

    def create_table(self, ident, schema=None):
        self.log.append(("create", ident))
        return FakeTable(self.log, "created")

    def load_table(self, ident):
        self.log.append(("load", ident))
        return FakeTable(self.log, "loaded")


class FakeS3:
    def get_object(self, Bucket, Key):
        return {"Body": mock.Mock(read=lambda: b"id,amount\n1,2\n")}


def run_ingest(body, exists=False):
    log = []
    with mock.patch.object(app, "_s3_client", lambda: FakeS3()), \
         mock.patch.object(app, "_catalog", lambda: FakeCatalog(log, exists=exists)), \
         mock.patch.object(app, "_read_to_arrow", lambda p, k: FakeArrow()):
        out = app.ingest(body)
    return out, log


BASE = {"principal": "lena", "dataset": "orders", "objectKey": "uploads/lena/orders.csv"}


class GuardTests(unittest.TestCase):
    def test_missing_fields_rejected(self):
        for missing in ("principal", "dataset", "objectKey"):
            body = {**BASE, missing: ""}
            with self.assertRaises(ValueError):
                run_ingest(body)

    def test_bad_mode_rejected(self):
        with self.assertRaises(ValueError):
            run_ingest({**BASE, "mode": "upsert"})

    def test_cross_user_object_rejected(self):
        with self.assertRaises(PermissionError):
            run_ingest({**BASE, "objectKey": "uploads/maya/orders.csv"})

    def test_foreign_schema_rejected(self):
        with self.assertRaises(PermissionError):
            run_ingest({**BASE, "schema": "sales"})


class ModeTests(unittest.TestCase):
    def test_default_replace_drops_and_recreates(self):
        out, log = run_ingest(dict(BASE), exists=True)
        self.assertEqual(out["mode"], "replace")
        self.assertEqual(out["table"], "iceberg.personal_lena.bronze_orders")
        ops = [op for op, *_ in log]
        self.assertIn("drop", ops)
        self.assertIn("create", ops)
        self.assertNotIn("load", ops)
        self.assertEqual(log[-1], ("append", "created", 3))

    def test_append_keeps_existing_table(self):
        out, log = run_ingest({**BASE, "mode": "append"}, exists=True)
        self.assertEqual(out["mode"], "append")
        ops = [op for op, *_ in log]
        self.assertNotIn("drop", ops)
        self.assertNotIn("create", ops)
        self.assertIn("load", ops)
        self.assertEqual(log[-1], ("append", "loaded", 3))

    def test_append_on_missing_table_creates_it(self):
        out, log = run_ingest({**BASE, "mode": "append"}, exists=False)
        self.assertEqual(out["mode"], "append")
        ops = [op for op, *_ in log]
        self.assertNotIn("drop", ops)
        self.assertIn("create", ops)
        self.assertEqual(log[-1], ("append", "created", 3))

    def test_row_count_and_columns_reported(self):
        out, _ = run_ingest(dict(BASE))
        self.assertEqual(out["rowCount"], 3)
        self.assertEqual([c["name"] for c in out["columns"]], ["id", "amount"])


ROWS_BASE = {
    "principal": "lena",
    "dataset": "accounts",
    "rows": [{"id": 1, "name": "Acme"}, {"id": 2, "name": "Globex"}],
}


def run_ingest_rows(body, exists=False):
    log = []
    with mock.patch.object(app, "_catalog", lambda: FakeCatalog(log, exists=exists)), \
         mock.patch.object(app, "_read_to_arrow", lambda p, k: FakeArrow(len(body.get("rows", [])))):
        out = app.ingest_rows(body)
    return out, log


class IngestRowsGuardTests(unittest.TestCase):
    def test_missing_principal_rejected(self):
        with self.assertRaises(ValueError):
            run_ingest_rows({**ROWS_BASE, "principal": ""})

    def test_missing_dataset_rejected(self):
        with self.assertRaises(ValueError):
            run_ingest_rows({**ROWS_BASE, "dataset": ""})

    def test_missing_rows_rejected(self):
        body = {k: v for k, v in ROWS_BASE.items() if k != "rows"}
        with self.assertRaises(ValueError):
            run_ingest_rows(body)

    def test_empty_rows_rejected(self):
        with self.assertRaises(ValueError):
            run_ingest_rows({**ROWS_BASE, "rows": []})

    def test_rows_cap_exceeded_rejected(self):
        big = [{"id": i} for i in range(10_001)]
        with self.assertRaises(ValueError):
            run_ingest_rows({**ROWS_BASE, "rows": big})

    def test_foreign_schema_rejected(self):
        with self.assertRaises(PermissionError):
            run_ingest_rows({**ROWS_BASE, "schema": "sales"})

    def test_correct_personal_schema_accepted(self):
        # Explicitly passing the correct personal schema must not raise.
        out, _ = run_ingest_rows({**ROWS_BASE, "schema": "personal_lena"})
        self.assertTrue(out["ok"])


class IngestRowsModeTests(unittest.TestCase):
    def test_append_keeps_existing_table(self):
        out, log = run_ingest_rows({**ROWS_BASE, "mode": "append"}, exists=True)
        self.assertEqual(out["mode"], "append")
        ops = [op for op, *_ in log]
        self.assertNotIn("drop", ops)
        self.assertNotIn("create", ops)
        self.assertIn("load", ops)
        self.assertEqual(log[-1][0], "append")

    def test_replace_drops_and_recreates(self):
        out, log = run_ingest_rows({**ROWS_BASE, "mode": "replace"}, exists=True)
        self.assertEqual(out["mode"], "replace")
        self.assertEqual(out["table"], "iceberg.personal_lena.bronze_accounts")
        ops = [op for op, *_ in log]
        self.assertIn("drop", ops)
        self.assertIn("create", ops)
        self.assertNotIn("load", ops)

    def test_append_on_missing_table_creates_it(self):
        out, log = run_ingest_rows({**ROWS_BASE, "mode": "append"}, exists=False)
        ops = [op for op, *_ in log]
        self.assertNotIn("drop", ops)
        self.assertIn("create", ops)
        self.assertNotIn("load", ops)


class IngestRowsNdjsonTests(unittest.TestCase):
    """Verify that rows reach _read_to_arrow via a well-formed NDJSON temp file."""

    def test_ndjson_temp_file_format(self):
        captured = {}

        def fake_read_to_arrow(path, key):
            # key must end in .ndjson so read_json_auto is selected.
            captured["key"] = key
            # Read the temp file while it still exists (delete=True but still open).
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            captured["lines"] = lines
            return FakeArrow(len(lines))

        log = []
        with mock.patch.object(app, "_catalog", lambda: FakeCatalog(log, exists=False)), \
             mock.patch.object(app, "_read_to_arrow", fake_read_to_arrow):
            out = app.ingest_rows(ROWS_BASE)

        # Each source row must produce exactly one valid JSON object on its own line.
        self.assertEqual(len(captured["lines"]), len(ROWS_BASE["rows"]))
        for line, expected_row in zip(captured["lines"], ROWS_BASE["rows"]):
            self.assertEqual(json.loads(line), expected_row)

        # The key passed to _read_to_arrow must end in .ndjson so PyArrow uses
        # read_json (same extension branch as _read_to_arrow's own dispatch).
        self.assertTrue(captured["key"].endswith(".ndjson"), captured["key"])

        self.assertEqual(out["rowCount"], len(ROWS_BASE["rows"]))


# ─────────────────────────────────────────────────────────────────────────────────
# Failure-mode tests — arrow-read / append errors must surface cleanly
# ─────────────────────────────────────────────────────────────────────────────────

class FailureModeTests(unittest.TestCase):
    """Stub _read_to_arrow to raise; assert clean error, not partial table or
    raw traceback leaking into the response."""

    def test_arrow_read_failure_raises_clean_exception(self):
        """_read_to_arrow raising must propagate as a clean exception from ingest(),
        not silently succeed with a partial or empty table."""
        log = []

        def raising_read(*_a, **_kw):
            raise RuntimeError("PyArrow: cannot parse file — corrupt data")

        with mock.patch.object(app, "_s3_client", lambda: FakeS3()), \
             mock.patch.object(app, "_catalog", lambda: FakeCatalog(log, exists=False)), \
             mock.patch.object(app, "_read_to_arrow", raising_read):
            with self.assertRaises(Exception) as ctx:
                app.ingest(dict(BASE))

        # The exception message must be meaningful — not a raw AttributeError from
        # trying to call .schema on None or similar.
        self.assertIn("PyArrow", str(ctx.exception),
                      "the original error message must be preserved, not swallowed")
        # Nothing was written to Iceberg — no create/append in the log.
        ops = [op for op, *_ in log]
        self.assertNotIn("append", ops, "no partial write must occur when read fails")
        self.assertNotIn("create", ops)

    def test_arrow_append_failure_raises_clean_exception(self):
        """catalog.append raising (schema mismatch, network issue) must bubble up
        cleanly from ingest() so the HTTP handler can return a 500 with the real error."""
        log = []

        class FailingTable:
            def append(self, _arrow):
                raise IOError("Polaris: write delegation denied — use STAGED create")

        class FailingCatalog(FakeCatalog):
            def create_table(self, ident, schema=None):
                self.log.append(("create", ident))
                return FailingTable()

        with mock.patch.object(app, "_s3_client", lambda: FakeS3()), \
             mock.patch.object(app, "_catalog", lambda: FailingCatalog(log, exists=False)), \
             mock.patch.object(app, "_read_to_arrow", lambda *_: FakeArrow()):
            with self.assertRaises(Exception) as ctx:
                app.ingest(dict(BASE))

        self.assertIn("Polaris", str(ctx.exception),
                      "the Polaris write error must surface verbatim")
        # A create was attempted (table didn't exist) but no partial write succeeded.
        ops = [op for op, *_ in log]
        self.assertIn("create", ops)
        # The real append was tried (it raised) — no second append must follow.
        self.assertEqual(ops.count("append"), 0,
                         "failed append must not produce a second silent attempt")

    def test_ingest_rows_arrow_read_failure_surfaces_cleanly(self):
        """Same guarantee for ingest_rows(): a _read_to_arrow failure must raise,
        not return an 'ok' response with 0 rows."""
        log = []

        def raising_read(*_a, **_kw):
            raise ValueError("read_json_auto: unexpected token at position 0")

        with mock.patch.object(app, "_catalog", lambda: FakeCatalog(log, exists=False)), \
             mock.patch.object(app, "_read_to_arrow", raising_read):
            with self.assertRaises(Exception) as ctx:
                app.ingest_rows(dict(ROWS_BASE))

        self.assertIn("read_json_auto", str(ctx.exception))
        ops = [op for op, *_ in log]
        self.assertNotIn("append", ops)


class TestServiceBearer(unittest.TestCase):
    """The service-bearer guard: constant-time token check on /ingest + /ingest-rows.
    When SERVICE_BEARER_TOKEN is unset the check is disabled (fail-open by design —
    the NetworkPolicy is the primary boundary). /health never carries the token."""

    def test_absent_env_allows_any_request(self):
        # No token configured -> every request passes (today's behaviour preserved).
        with mock.patch.object(app, "SERVICE_BEARER_TOKEN", ""):
            self.assertTrue(app.bearer_ok(""))
            self.assertTrue(app.bearer_ok("Bearer whatever"))
            self.assertTrue(app.bearer_ok("garbage"))

    def test_valid_token_passes(self):
        with mock.patch.object(app, "SERVICE_BEARER_TOKEN", "s3cr3t"):
            self.assertTrue(app.bearer_ok("Bearer s3cr3t"))
            self.assertTrue(app.bearer_ok("bearer s3cr3t"))  # scheme case-insensitive

    def test_missing_or_wrong_token_rejected(self):
        with mock.patch.object(app, "SERVICE_BEARER_TOKEN", "s3cr3t"):
            self.assertFalse(app.bearer_ok(""))               # no header
            self.assertFalse(app.bearer_ok("s3cr3t"))          # no Bearer scheme
            self.assertFalse(app.bearer_ok("Bearer wrong"))    # wrong token
            self.assertFalse(app.bearer_ok("Bearer "))         # empty token
            self.assertFalse(app.bearer_ok("Bearer s3cr3t "))  # trailing space differs


if __name__ == "__main__":
    unittest.main(verbosity=2)

# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Unit tests for the data-runner's ingest logic (guards + replace/append modes).

The heavy runtime deps (boto3/duckdb/pyiceberg) are stubbed in sys.modules BEFORE
importing app.py, and the network-touching seams (_s3_client/_catalog/_read_to_arrow)
are monkeypatched with fakes — so these run with stdlib + pytest only:

    python3 -m pytest -q test_app.py
"""
import json
import sys
import types
import unittest
from unittest import mock

# ---- Stub the runtime-only deps so `import app` works without the image env. ----
for name in ("boto3", "duckdb"):
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

        # The key passed to _read_to_arrow must end in .ndjson so DuckDB uses
        # read_json_auto (same extension branch as _read_to_arrow's own dispatch).
        self.assertTrue(captured["key"].endswith(".ndjson"), captured["key"])

        self.assertEqual(out["rowCount"], len(ROWS_BASE["rows"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)

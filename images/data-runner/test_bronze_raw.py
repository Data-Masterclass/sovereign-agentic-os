# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Bronze is the RAW landing — no automatic type coercion.

Regression guard for the reported bug: a CSV column of "yes"/"no" strings was
being auto-converted to boolean true/false at Bronze (DuckDB read_csv_auto infers
types from the text). Bronze must preserve the bytes as-is; type conversion is an
opt-in Silver step. Run:  python3 -m pytest -q test_bronze_raw.py
"""
import importlib
import sys
import tempfile
import types
import unittest

# Stub the runtime-only deps so `import app` works — but DO NOT stub duckdb here,
# the behaviour test needs the real engine.
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

import app  # noqa: E402


def _real_duckdb():
    """Return the REAL duckdb module (not a sibling test's stub), or None if it
    isn't installed. A sibling test may have registered a bare-ModuleType stub in
    sys.modules; drop it and import the genuine package."""
    mod = sys.modules.get("duckdb")
    if mod is not None and not hasattr(mod, "connect"):
        del sys.modules["duckdb"]  # a stub — evict it
    try:
        mod = importlib.import_module("duckdb")
    except Exception:
        return None
    return mod if hasattr(mod, "connect") else None


class IngestSelectTests(unittest.TestCase):
    """The SQL builder must force VARCHAR for delimited text and leave typed
    formats (parquet/json) alone. Pure — no engine needed, always runs."""

    def test_csv_reads_all_varchar(self):
        for key in ("uploads/u/x.csv", "uploads/u/x.CSV", "uploads/u/x.tsv", "uploads/u/x.txt"):
            sql = app._ingest_select("/tmp/f", key)
            self.assertIn("read_csv_auto", sql)
            self.assertIn("all_varchar=true", sql,
                          f"Bronze CSV read must be all_varchar (raw) for {key}: {sql}")

    def test_parquet_keeps_source_types(self):
        sql = app._ingest_select("/tmp/f", "uploads/u/x.parquet")
        self.assertIn("read_parquet", sql)
        self.assertNotIn("all_varchar", sql)  # typed columnar source — never forced

    def test_json_keeps_native_types(self):
        for key in ("uploads/u/x.json", "uploads/u/x.ndjson"):
            sql = app._ingest_select("/tmp/f", key)
            self.assertIn("read_json_auto", sql)
            self.assertNotIn("all_varchar", sql)


class RawBronzeBehaviourTests(unittest.TestCase):
    """End-to-end against the real DuckDB engine: a yes/no + numbers + dates CSV
    must land as ALL VARCHAR with the literal values preserved — no coercion."""

    def setUp(self):
        self.duckdb = _real_duckdb()
        if self.duckdb is None:
            self.skipTest("duckdb not installed in this environment")

    def _describe_types(self, sql):
        con = self.duckdb.connect()
        try:
            return {row[1] for row in con.execute("DESCRIBE " + sql).fetchall()}
        finally:
            con.close()

    def test_yes_no_stays_string_not_boolean(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", dir="/tmp", delete=True) as f:
            f.write("name,in_stock,qty,joined\nWidget,yes,40,2024-01-01\nGadget,no,3,2024-02-02\n")
            f.flush()
            sql = app._ingest_select(f.name, "orders.csv")
            # Every column raw VARCHAR — no BOOLEAN/BIGINT/DATE inference.
            self.assertEqual(self._describe_types(sql), {"VARCHAR"})
            # The literal values survive: still "yes"/"no", not true/false.
            con = self.duckdb.connect()
            try:
                vals = [r[0] for r in con.execute(
                    f"SELECT in_stock FROM read_csv_auto('{f.name}', all_varchar=true)").fetchall()]
            finally:
                con.close()
            self.assertEqual(vals, ["yes", "no"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

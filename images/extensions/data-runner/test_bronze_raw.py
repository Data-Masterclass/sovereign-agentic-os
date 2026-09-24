# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Bronze is the RAW landing — no automatic type coercion (PyArrow reader, no DuckDB).

Regression guard for the reported bug: a CSV column of "yes"/"no" strings was being
auto-converted to boolean true/false at Bronze. The ingest now reads with PyArrow —
CSV forced to all-string (raw), Parquet/JSON keeping their native types — and DuckDB
is gone from the data-runner entirely. Run:  python3 -m pytest -q test_bronze_raw.py
"""
import os
import sys
import tempfile
import types
import unittest

# Stub only boto3/pyiceberg so `import app` needs no cluster. PyArrow is a REAL dep
# (the ingest reader) and is NOT stubbed — these tests exercise the genuine reader.
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


def _write(suffix: str, text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix, dir="/tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


class NoDuckDbTests(unittest.TestCase):
    def test_duckdb_is_gone(self):
        # The sovereign stack has one query engine (Trino); the ingest reader is
        # PyArrow. DuckDB must not be imported or referenced by the data-runner.
        self.assertNotIn("duckdb", sys.modules, "data-runner must not import duckdb")
        self.assertFalse(hasattr(app, "duckdb"), "app must not hold a duckdb handle")


class RawBronzeReaderTests(unittest.TestCase):
    """The real PyArrow reader: delimited text lands as ALL strings (raw, no coercion),
    typed formats (parquet/json) keep their native types."""

    def _types(self, table):
        return {f.name: str(f.type) for f in table.schema}

    def test_csv_yes_no_stays_string_not_boolean(self):
        p = _write(".csv", "name,in_stock,qty,joined\nWidget,yes,40,2024-01-01\nGadget,no,3,2024-02-02\n")
        try:
            t = app._read_to_arrow(p, "orders.csv")
            self.assertEqual(set(self._types(t).values()), {"string"},
                             "every Bronze CSV column must be raw string — no bool/int/date inference")
            self.assertEqual(t.column("in_stock").to_pylist(), ["yes", "no"])  # literal, not true/false
            self.assertEqual(t.column("qty").to_pylist(), ["40", "3"])          # literal, not int
            self.assertEqual(t.num_rows, 2)
        finally:
            os.remove(p)

    def test_tsv_is_tab_delimited_and_all_string(self):
        p = _write(".tsv", "a\tb\n1\tyes\n2\tno\n")
        try:
            t = app._read_to_arrow(p, "x.tsv")
            self.assertEqual([f.name for f in t.schema], ["a", "b"])  # tab split, not one column
            self.assertEqual(set(self._types(t).values()), {"string"})
        finally:
            os.remove(p)

    def test_json_keeps_native_types(self):
        p = _write(".ndjson", '{"id":1,"active":true}\n{"id":2,"active":false}\n')
        try:
            t = app._read_to_arrow(p, "x.ndjson")
            self.assertEqual(self._types(t)["id"], "int64")   # JSON has real type tokens
            self.assertEqual(self._types(t)["active"], "bool")
        finally:
            os.remove(p)

    def test_parquet_keeps_source_types(self):
        import pyarrow as pa
        from pyarrow import parquet as papq
        p = _write(".parquet", "")
        papq.write_table(pa.table({"n": [1, 2], "ok": [True, False]}), p)
        try:
            t = app._read_to_arrow(p, "x.parquet")
            self.assertEqual(self._types(t)["n"], "int64")    # typed columnar source preserved
            self.assertEqual(self._types(t)["ok"], "bool")
        finally:
            os.remove(p)


if __name__ == "__main__":
    unittest.main(verbosity=2)

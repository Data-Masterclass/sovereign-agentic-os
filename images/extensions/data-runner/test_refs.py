# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Unit tests for /refs (WP-37): the schema gate and input checks run BEFORE any catalog call.

The real PyIceberg -> Polaris commit is proven in os-ui/tabs/data/lib/dataset-versions.trino.test.ts
on the lakehouse harness. Here the catalog seam is a fake, so a refused call can be shown to touch
nothing:  python3 -m pytest -q test_refs.py
"""
import sys
import types
import unittest
from unittest import mock

for name in ("boto3",):
    sys.modules.setdefault(name, types.ModuleType(name))
_bc = types.ModuleType("botocore.config")
_bc.Config = object
sys.modules.setdefault("botocore", types.ModuleType("botocore"))
sys.modules.setdefault("botocore.config", _bc)
_pc = types.ModuleType("pyiceberg.catalog")
_pc.load_catalog = lambda *a, **k: None
sys.modules.setdefault("pyiceberg", types.ModuleType("pyiceberg"))
sys.modules.setdefault("pyiceberg.catalog", _pc)

import app  # noqa: E402


class FakeTable:
    def __init__(self, snaps, refs=None):
        self._snaps = set(snaps)
        self.metadata = types.SimpleNamespace(refs=dict(refs or {}))
        self.calls = []

    def snapshot_by_id(self, sid):
        return object() if sid in self._snaps else None

    def manage_snapshots(self):
        t = self

        class MS:
            def create_tag(self, sid, name):
                t.calls.append(("tag", sid, name))
                return self

            def create_branch(self, sid, name):
                t.calls.append(("branch", sid, name))
                return self

            def commit(self):
                sid, name = t.calls[-1][1], t.calls[-1][2]
                t.metadata.refs[name] = types.SimpleNamespace(snapshot_id=sid)

        return MS()


class FakeCatalog:
    def __init__(self, table):
        self.table = table
        self.loaded = []

    def load_table(self, ident):
        self.loaded.append(ident)
        return self.table


BASE = dict(principal="lena", uid="lena", role="creator", domains=["sales"],
            schema="personal_lena", table="gold_orders_ab12", kind="tag", name="q3-close",
            snapshotId="8954597067493422955")


class RefsTests(unittest.TestCase):
    def run_with(self, body, table=None):
        cat = FakeCatalog(table or FakeTable({8954597067493422955}))
        with mock.patch.object(app, "_catalog", return_value=cat):
            return app.create_ref(body), cat

    def test_tag_on_own_lane(self):
        out, cat = self.run_with(dict(BASE))
        self.assertEqual(out["name"], "q3-close")
        self.assertEqual(cat.table.calls, [("tag", 8954597067493422955, "q3-close")])

    def test_branch(self):
        out, cat = self.run_with(dict(BASE, kind="branch", name="audit"))
        self.assertEqual(cat.table.calls[0][0], "branch")

    def test_domain_needs_builder_and_membership(self):
        for body in (dict(BASE, schema="sales"), dict(BASE, schema="finance", role="admin")):
            cat = FakeCatalog(FakeTable({8954597067493422955}))
            with mock.patch.object(app, "_catalog", return_value=cat):
                with self.assertRaises(PermissionError):
                    app.create_ref(body)
            self.assertEqual(cat.loaded, [], "refused before any catalog call")
        out, _ = self.run_with(dict(BASE, schema="sales", role="builder"))
        self.assertEqual(out["table"], "iceberg.sales.gold_orders_ab12")

    def test_bad_inputs_rejected(self):
        for bad in (dict(BASE, name="main"), dict(BASE, name="x' or '1"), dict(BASE, snapshotId="1 or 1"),
                    dict(BASE, schema="personal_lena; drop"), dict(BASE, kind="tags")):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    self.run_with(bad)

    def test_unknown_snapshot_and_taken_name(self):
        with self.assertRaises(ValueError):
            self.run_with(dict(BASE, snapshotId="42"))
        taken = FakeTable({8954597067493422955}, refs={"q3-close": types.SimpleNamespace(snapshot_id=1)})
        with self.assertRaises(ValueError):
            self.run_with(dict(BASE), table=taken)
        self.assertEqual(taken.calls, [], "a taken name is never moved")


if __name__ == "__main__":
    unittest.main()

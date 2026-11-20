# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""DROP SCHEMA is on the write allowlist ONLY for os-ui's governed delete-domain run.

Each allowed case has a negative twin that changes exactly one input and must be refused."""
import unittest

import _stubs  # noqa: F401  (puts the package dir on sys.path)
from execute_guard import ExecuteError, guard  # noqa: E402

SQL = "DROP SCHEMA IF EXISTS iceberg.personal_jonas"


class DropSchemaGuard(unittest.TestCase):
    def test_delete_domain_admin_drops_the_owners_personal_schema(self):
        p = guard(SQL, "jonas", ["k"], "admin", "domain-delete")
        self.assertEqual((p.kind, p.schema), ("drop_schema", "personal_jonas"))

    def test_twin_without_the_purpose_is_refused(self):
        with self.assertRaises(ExecuteError) as e:
            guard(SQL, "jonas", ["k"], "admin")
        self.assertEqual(e.exception.status, 403)

    def test_twin_with_another_purpose_is_refused(self):
        with self.assertRaises(ExecuteError):
            guard(SQL, "jonas", ["k"], "admin", "data-delete")

    def test_twin_without_admin_is_refused(self):
        with self.assertRaises(ExecuteError) as e:
            guard(SQL, "jonas", ["k"], "domain_admin", "domain-delete")
        self.assertEqual(e.exception.status, 403)

    def test_twin_on_someone_elses_schema_is_refused(self):
        with self.assertRaises(ExecuteError) as e:
            guard("DROP SCHEMA IF EXISTS iceberg.personal_aborek", "jonas", ["k"], "admin", "domain-delete")
        self.assertEqual(e.exception.status, 403)

    def test_domain_schema_of_a_domain_of_the_identity(self):
        p = guard("DROP SCHEMA IF EXISTS iceberg.kiekert", "alex", ["kiekert"], "admin", "domain-delete")
        self.assertEqual(p.schema, "kiekert")
        with self.assertRaises(ExecuteError):
            guard("DROP SCHEMA IF EXISTS iceberg.agentic_leader_q3_2026", "alex", ["kiekert"], "admin", "domain-delete")

    def test_cascade_and_other_shapes_stay_off_the_allowlist(self):
        for sql in ("DROP SCHEMA iceberg.personal_jonas", "DROP SCHEMA IF EXISTS iceberg.personal_jonas CASCADE",
                    "DROP SCHEMA IF EXISTS personal_jonas", "DROP SCHEMA IF EXISTS iceberg.personal_jonas; SELECT 1"):
            with self.assertRaises(ExecuteError) as e:
                guard(sql, "jonas", ["k"], "admin", "domain-delete")
            self.assertEqual(e.exception.status, 400, sql)


if __name__ == "__main__":
    unittest.main()


class PurgeCatalogGuard(unittest.TestCase):
    """The purge catalog: only drops, only the delete-domain run, run as the purge user."""

    def test_delete_domain_drop_on_the_purge_catalog_runs_as_the_purge_user(self):
        from execute_guard import execute_user
        p = guard("DROP TABLE IF EXISTS iceberg_purge.personal_jonas.bronze_test", "jonas", ["k"], "admin", "domain-delete")
        self.assertEqual((p.kind, p.catalog), ("drop_table", "iceberg_purge"))
        self.assertEqual(execute_user(p, "jonas", "os-domain-delete"), "os-domain-delete")

    def test_twin_a_data_tab_drop_stays_on_iceberg_as_the_caller(self):
        from execute_guard import execute_user
        p = guard("DROP TABLE IF EXISTS iceberg.personal_jonas.bronze_test", "jonas", ["k"], "creator")
        self.assertEqual(p.catalog, "iceberg")
        self.assertEqual(execute_user(p, "jonas", "os-domain-delete"), "jonas")

    def test_twin_the_purge_catalog_without_the_purpose_or_admin_is_refused(self):
        for args in (("jonas", ["k"], "admin"), ("jonas", ["k"], "creator", "domain-delete")):
            with self.assertRaises(ExecuteError) as e:
                guard("DROP TABLE IF EXISTS iceberg_purge.personal_jonas.bronze_test", *args)
            self.assertEqual(e.exception.status, 403)

    def test_no_other_statement_reaches_the_purge_catalog(self):
        with self.assertRaises(ExecuteError) as e:
            guard("CREATE OR REPLACE TABLE iceberg_purge.personal_jonas.t AS SELECT 1", "jonas", ["k"], "admin", "domain-delete")
        self.assertEqual(e.exception.status, 400)

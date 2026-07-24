# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Unit tests for the governed-write guard. Stdlib only — run with:

    python3 test_execute_guard.py

(no pytest dependency; matches the query-tool image, which pins no test tooling).
"""
import unittest

from execute_guard import (
    ExecuteError,
    connect_kwargs,
    guard,
    parse_statement,
    personal_schema,
)

# A sales builder, a sales creator, and their personal schemas.
BUILDER = dict(uid="maya", domains=["sales"], role="builder")
CREATOR = dict(uid="lena", domains=["sales"], role="creator")


def status_of(fn):
    try:
        fn()
    except ExecuteError as e:
        return e.status
    return None  # no error raised


class AllowlistTests(unittest.TestCase):
    def test_personal_ctas_ok(self):
        p = guard(
            "CREATE OR REPLACE TABLE iceberg.personal_lena.silver_x AS SELECT 1 AS a",
            **CREATOR,
        )
        self.assertEqual(p.kind, "ctas")
        self.assertEqual(p.schema, "personal_lena")
        self.assertEqual(p.table, "silver_x")

    def test_domain_ctas_as_builder_ok(self):
        p = guard(
            "CREATE OR REPLACE TABLE iceberg.sales.silver_orders AS SELECT * FROM iceberg.sales.bronze_orders",
            **BUILDER,
        )
        self.assertEqual(p.schema, "sales")

    def test_create_table_if_not_exists_ok(self):
        p = guard(
            "CREATE TABLE IF NOT EXISTS iceberg.sales.gold_o AS SELECT 1 AS a",
            **BUILDER,
        )
        self.assertEqual(p.kind, "ctas")

    def test_create_schema_ok(self):
        self.assertEqual(
            guard("CREATE SCHEMA IF NOT EXISTS iceberg.personal_lena", **CREATOR).kind,
            "create_schema",
        )
        self.assertEqual(
            guard("CREATE SCHEMA IF NOT EXISTS iceberg.sales", **BUILDER).kind,
            "create_schema",
        )

    def test_drop_table_ok(self):
        p = guard("DROP TABLE IF EXISTS iceberg.personal_lena.silver_x", **CREATOR)
        self.assertEqual(p.kind, "drop_table")

    def test_multiline_ctas_ok(self):
        sql = (
            "CREATE OR REPLACE TABLE iceberg.sales.silver_orders AS\n"
            "SELECT id, region\nFROM iceberg.sales.bronze_orders\nWHERE id > 0"
        )
        self.assertEqual(guard(sql, **BUILDER).schema, "sales")

    def test_trailing_semicolon_tolerated(self):
        self.assertEqual(
            guard("DROP TABLE IF EXISTS iceberg.sales.gold_o ;", **BUILDER).kind,
            "drop_table",
        )


class RejectTests(unittest.TestCase):
    def _reject400(self, sql, ident=BUILDER):
        self.assertEqual(status_of(lambda: guard(sql, **ident)), 400, sql)

    def test_insert_rejected(self):
        self._reject400("INSERT INTO iceberg.sales.gold_o VALUES (1)")

    def test_update_rejected(self):
        self._reject400("UPDATE iceberg.sales.gold_o SET a = 1")

    def test_delete_rejected(self):
        self._reject400("DELETE FROM iceberg.sales.gold_o")

    def test_grant_rejected(self):
        self._reject400("GRANT SELECT ON iceberg.sales.gold_o TO alice")

    def test_alter_rejected(self):
        self._reject400("ALTER TABLE iceberg.sales.gold_o ADD COLUMN b int")

    def test_plain_create_table_rejected(self):
        # No OR REPLACE and no IF NOT EXISTS -> not on the allowlist.
        self._reject400("CREATE TABLE iceberg.sales.gold_o AS SELECT 1 AS a")

    def test_create_table_without_select_rejected(self):
        self._reject400("CREATE OR REPLACE TABLE iceberg.sales.gold_o (a int)")

    def test_second_statement_rejected(self):
        self._reject400(
            "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 AS a; DROP TABLE iceberg.sales.other"
        )

    def test_line_comment_smuggle_rejected(self):
        self._reject400(
            "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 AS a -- ; DROP TABLE x"
        )

    def test_block_comment_smuggle_rejected(self):
        self._reject400(
            "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 /* x */ AS a"
        )

    def test_non_iceberg_catalog_rejected(self):
        self._reject400("CREATE OR REPLACE TABLE system.sales.gold_o AS SELECT 1 AS a")

    def test_quoted_identifier_rejected(self):
        self._reject400('CREATE OR REPLACE TABLE iceberg."Sales".gold_o AS SELECT 1 AS a')

    def test_empty_rejected(self):
        self._reject400("   ")


class TargetAuthzTests(unittest.TestCase):
    def test_cross_domain_write_forbidden(self):
        # sales builder aiming at the marketing domain schema -> 403
        st = status_of(
            lambda: guard(
                "CREATE OR REPLACE TABLE iceberg.marketing.gold_o AS SELECT 1 AS a",
                **BUILDER,
            )
        )
        self.assertEqual(st, 403)

    def test_domain_write_requires_builder(self):
        # A creator may NOT write to the domain schema (role floor = builder).
        st = status_of(
            lambda: guard(
                "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 AS a",
                **CREATOR,
            )
        )
        self.assertEqual(st, 403)

    def test_creator_cannot_touch_other_users_personal(self):
        st = status_of(
            lambda: guard(
                "CREATE OR REPLACE TABLE iceberg.personal_maya.x AS SELECT 1 AS a",
                **CREATOR,
            )
        )
        self.assertEqual(st, 403)

    def test_admin_may_write_domain(self):
        p = guard(
            "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 AS a",
            uid="root",
            domains=["sales"],
            role="admin",
        )
        self.assertEqual(p.schema, "sales")

    def test_domain_admin_may_write_domain(self):
        # domain_admin ranks ABOVE builder (creator<builder<domain_admin<admin),
        # so it must clear the builder write-floor for its own domain schema.
        p = guard(
            "CREATE OR REPLACE TABLE iceberg.sales.gold_o AS SELECT 1 AS a",
            uid="jonas",
            domains=["sales"],
            role="domain_admin",
        )
        self.assertEqual(p.schema, "sales")

    def test_email_uid_maps_to_personal_schema(self):
        self.assertEqual(personal_schema("omar@acme.example"), "personal_omar_acme_example")
        p = guard(
            "DROP TABLE IF EXISTS iceberg.personal_omar_acme_example.x",
            uid="omar@acme.example",
            domains=["sales"],
            role="creator",
        )
        self.assertEqual(p.kind, "drop_table")


class PrincipalThreadingTests(unittest.TestCase):
    def test_ctas_reading_masked_table_still_runs_as_principal(self):
        # A CTAS whose SELECT reads a governed (potentially masked) table is allowed
        # by the guard, AND the connection threads the CALLER's principal as the
        # Trino session user — so the Trino->OPA plugin masks/filters the read AS
        # THE CALLER. The principal is never dropped for a service identity.
        guard(
            "CREATE OR REPLACE TABLE iceberg.sales.silver_pii AS "
            "SELECT id, email FROM iceberg.sales.bronze_customers",
            **BUILDER,
        )
        kw = connect_kwargs(
            "sales",
            "sales",
            host="trino",
            port=8080,
            catalog="iceberg",
            http_scheme="http",
            default_user="query-agent",
        )
        self.assertEqual(kw["user"], "sales", "principal must be the Trino session user")
        self.assertNotEqual(kw["user"], "query-agent", "must not fall back to the service user")

    def test_missing_principal_falls_back_to_service_user(self):
        kw = connect_kwargs(
            None, None, host="trino", port=8080, catalog="iceberg",
            http_scheme="http", default_user="query-agent",
        )
        self.assertEqual(kw["user"], "query-agent")


if __name__ == "__main__":
    unittest.main(verbosity=2)

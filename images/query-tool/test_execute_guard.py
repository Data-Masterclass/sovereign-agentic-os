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


class SyncWriteTests(unittest.TestCase):
    """The scheduled-incremental-sync shapes: INSERT..SELECT, MERGE, expire_snapshots.
    Same target-schema/role gate as a CTAS; plain literal writes stay rejected."""

    def _reject(self, sql, status, ident=BUILDER):
        self.assertEqual(status_of(lambda: guard(sql, **ident)), status, sql)

    def test_insert_select_personal_ok(self):
        p = guard(
            "INSERT INTO iceberg.personal_lena.bronze_orders "
            "SELECT * FROM pg_shop.public.orders WHERE updated_at > TIMESTAMP '2026-01-01 00:00:00'",
            **CREATOR,
        )
        self.assertEqual(p.kind, "insert_select")
        self.assertEqual(p.schema, "personal_lena")
        self.assertEqual(p.table, "bronze_orders")

    def test_insert_select_domain_as_builder_ok(self):
        p = guard(
            "INSERT INTO iceberg.sales.bronze_orders SELECT * FROM pg_shop.public.orders",
            **BUILDER,
        )
        self.assertEqual(p.kind, "insert_select")

    def test_insert_select_multiline_ok(self):
        sql = (
            "INSERT INTO iceberg.personal_lena.bronze_orders\n"
            "SELECT id, amount\nFROM pg_shop.public.orders\n"
            "WHERE id > 5 AND id <= 10"
        )
        self.assertEqual(guard(sql, **CREATOR).kind, "insert_select")

    def test_insert_values_rejected(self):
        self._reject("INSERT INTO iceberg.personal_lena.bronze_orders VALUES (1, 2)", 400, CREATOR)

    def test_insert_cross_schema_rejected(self):
        self._reject("INSERT INTO iceberg.marketing.bronze_orders SELECT 1 AS a", 403)

    def test_insert_domain_requires_builder(self):
        self._reject("INSERT INTO iceberg.sales.bronze_orders SELECT 1 AS a", 403, CREATOR)

    MERGE = (
        "MERGE INTO iceberg.personal_lena.bronze_orders AS t "
        "USING iceberg.personal_lena.bronze_orders_stg AS s ON t.id = s.id "
        "WHEN MATCHED THEN UPDATE SET amount = s.amount "
        "WHEN NOT MATCHED THEN INSERT (id, amount) VALUES (s.id, s.amount)"
    )

    def test_merge_personal_ok(self):
        p = guard(self.MERGE, **CREATOR)
        self.assertEqual(p.kind, "merge")
        self.assertEqual(p.schema, "personal_lena")
        self.assertEqual(p.table, "bronze_orders")

    def test_merge_without_alias_ok(self):
        sql = (
            "MERGE INTO iceberg.sales.bronze_orders "
            "USING iceberg.sales.bronze_orders_stg s ON bronze_orders.id = s.id "
            "WHEN MATCHED THEN UPDATE SET amount = s.amount"
        )
        self.assertEqual(guard(sql, **BUILDER).kind, "merge")

    def test_merge_cross_schema_rejected(self):
        sql = self.MERGE.replace("personal_lena", "marketing")
        self._reject(sql, 403)

    def test_merge_domain_requires_builder(self):
        sql = self.MERGE.replace("personal_lena", "sales")
        self._reject(sql, 403, CREATOR)

    def test_merge_without_when_rejected(self):
        self._reject(
            "MERGE INTO iceberg.sales.bronze_orders USING x ON a = b", 400,
        )

    def test_expire_snapshots_ok(self):
        p = guard(
            "ALTER TABLE iceberg.personal_lena.bronze_orders EXECUTE "
            "expire_snapshots(retention_threshold => '7d')",
            **CREATOR,
        )
        self.assertEqual(p.kind, "expire_snapshots")
        self.assertEqual(p.table, "bronze_orders")

    def test_expire_snapshots_domain_as_builder_ok(self):
        p = guard(
            "ALTER TABLE iceberg.sales.bronze_orders EXECUTE "
            "expire_snapshots(retention_threshold => '48h')",
            **BUILDER,
        )
        self.assertEqual(p.kind, "expire_snapshots")

    def test_expire_snapshots_cross_schema_rejected(self):
        self._reject(
            "ALTER TABLE iceberg.marketing.bronze_orders EXECUTE "
            "expire_snapshots(retention_threshold => '7d')",
            403,
        )

    def test_optimize_ok(self):
        p = guard("ALTER TABLE iceberg.sales.bronze_orders EXECUTE optimize", **BUILDER)
        self.assertEqual(p.kind, "optimize")
        p = guard(
            "ALTER TABLE iceberg.personal_lena.bronze_orders EXECUTE "
            "optimize(file_size_threshold => '128MB')",
            **CREATOR,
        )
        self.assertEqual(p.kind, "optimize")

    def test_optimize_cross_schema_rejected(self):
        self._reject("ALTER TABLE iceberg.marketing.bronze_orders EXECUTE optimize", 403)

    def test_other_execute_proc_rejected(self):
        self._reject(
            "ALTER TABLE iceberg.sales.bronze_orders EXECUTE remove_orphan_files(retention_threshold => '7d')",
            400,
        )

    def test_delete_batch_ok(self):
        p = guard(
            "DELETE FROM iceberg.personal_lena.bronze_orders WHERE _batch_id = 'ds_1:2026-01-01'",
            **CREATOR,
        )
        self.assertEqual(p.kind, "delete_batch")
        self.assertEqual(p.table, "bronze_orders")

    def test_delete_batch_cross_schema_rejected(self):
        self._reject(
            "DELETE FROM iceberg.marketing.bronze_orders WHERE _batch_id = 'b1'", 403,
        )

    def test_delete_batch_domain_requires_builder(self):
        self._reject(
            "DELETE FROM iceberg.sales.bronze_orders WHERE _batch_id = 'b1'", 403, CREATOR,
        )

    def test_delete_arbitrary_predicate_rejected(self):
        self._reject("DELETE FROM iceberg.sales.bronze_orders WHERE amount > 0", 400)
        self._reject(
            "DELETE FROM iceberg.sales.bronze_orders WHERE _batch_id = 'b1' OR true", 400,
        )
        # A quote can never widen the predicate — non-[safe] chars in the literal reject.
        self._reject(
            "DELETE FROM iceberg.sales.bronze_orders WHERE _batch_id = 'a'' OR ''1''=''1'", 400,
        )

    def test_expression_threshold_rejected(self):
        # Only a literal '<n>d'/'<n>h' threshold is allowed — no expressions.
        self._reject(
            "ALTER TABLE iceberg.sales.bronze_orders EXECUTE "
            "expire_snapshots(retention_threshold => interval '7' day)",
            400,
        )

    def test_update_and_delete_still_rejected(self):
        self._reject("UPDATE iceberg.sales.bronze_orders SET a = 1", 400)
        self._reject("DELETE FROM iceberg.sales.bronze_orders WHERE a = 1", 400)

    def test_insert_second_statement_rejected(self):
        self._reject(
            "INSERT INTO iceberg.sales.bronze_orders SELECT 1 AS a; DROP TABLE iceberg.sales.other",
            400,
        )

    def test_merge_comment_smuggle_rejected(self):
        self._reject(self.MERGE + " -- smuggled", 400, CREATOR)


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

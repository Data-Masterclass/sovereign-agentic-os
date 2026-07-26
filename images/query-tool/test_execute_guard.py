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
    guard_read,
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


class SyncGeneratedSqlTests(unittest.TestCase):
    """CROSS-CHECK: the exact statement shapes os-ui's sync builders emit
    (lib/data/sync-sql.ts) clear the allowlist. Kept as literal strings so a guard
    tightening that would break the scheduled sync fails HERE, in the guard's own
    suite, not in production. The kafka-offsets slice (v2 sync) is an INSERT-SELECT
    with a per-partition OR-window — the existing insert_select shape covers it, and
    the kafka full load is a plain CREATE OR REPLACE CTAS; NO new shape was added."""

    def test_kafka_append_slice_clears_insert_select(self):
        p = guard(
            "INSERT INTO iceberg.personal_lena.bronze_orders "
            "SELECT *, _partition_id AS _kafka_partition, _partition_offset AS _kafka_offset, "
            "TIMESTAMP '2026-02-01 00:00:00' AS _loaded_at, 'ds_1.k' AS _batch_id "
            "FROM kafka_events.default.orders WHERE "
            "(_partition_id = 0 AND _partition_offset > 41 AND _partition_offset <= 100) OR "
            "(_partition_id = 2 AND _partition_offset <= 3)",
            **CREATOR,
        )
        self.assertEqual(p.kind, "insert_select")
        self.assertEqual(p.schema, "personal_lena")

    def test_kafka_full_load_clears_ctas(self):
        p = guard(
            "CREATE OR REPLACE TABLE iceberg.personal_lena.bronze_orders AS "
            "SELECT *, _partition_id AS _kafka_partition, _partition_offset AS _kafka_offset, "
            "TIMESTAMP '2026-02-01 00:00:00' AS _loaded_at, 'ds_1.k' AS _batch_id "
            "FROM kafka_events.default.orders WHERE (_partition_id = 0 AND _partition_offset <= 41)",
            **CREATOR,
        )
        self.assertEqual(p.kind, "ctas")

    def test_operational_db_slice_clears_insert_select(self):
        # The timestamp-cursor slice against a federated OPERATIONAL catalog
        # (postgresql/mysql/sqlserver) — the same shape a warehouse slice uses.
        p = guard(
            "INSERT INTO iceberg.personal_lena.bronze_orders "
            "SELECT *, TIMESTAMP '2026-02-01 00:00:00' AS _loaded_at, 'ds1.2026' AS _batch_id "
            "FROM pg_shop.public.orders WHERE updated_at > "
            "TIMESTAMP '2026-01-01 00:00:00' - INTERVAL '15' MINUTE "
            "AND updated_at <= TIMESTAMP '2026-02-01 00:00:00'",
            **CREATOR,
        )
        self.assertEqual(p.kind, "insert_select")

    def test_sync_delete_batch_clears_delete_shape(self):
        p = guard(
            "DELETE FROM iceberg.personal_lena.bronze_orders WHERE _batch_id = 'ds1.0-100-1-7'",
            **CREATOR,
        )
        self.assertEqual(p.kind, "delete_batch")


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


class ReadGuardTests(unittest.TestCase):
    """The /query read-path defence-in-depth guard (guard_read). Read-only, single
    statement, no comment/stacked smuggling, no write/DDL/privilege verb."""

    def test_plain_select_ok(self):
        self.assertEqual(
            guard_read("SELECT order_date, revenue FROM daily_revenue ORDER BY 1"),
            "SELECT order_date, revenue FROM daily_revenue ORDER BY 1",
        )

    def test_with_cte_ok(self):
        guard_read("WITH t AS (SELECT 1 AS a) SELECT * FROM t")

    def test_show_tables_ok(self):
        # list_tables() runs `show tables` through run_query -> guard_read.
        guard_read("show tables")

    def test_describe_ok(self):
        guard_read("DESCRIBE iceberg.sales.daily_revenue")

    def test_explain_ok(self):
        guard_read("EXPLAIN SELECT * FROM iceberg.sales.orders")

    def test_trailing_semicolon_ok(self):
        guard_read("SELECT 1;")

    def test_replace_function_not_tripped(self):
        # `replace(...)` is a legitimate Trino string function, not a write verb.
        guard_read("SELECT replace(name, 'a', 'b') FROM iceberg.sales.orders")

    def test_column_named_like_verb_ok(self):
        # `created_at` / `updated_at` must not trip the create/update word match.
        guard_read("SELECT created_at, updated_at FROM iceberg.sales.orders")

    def test_insert_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("INSERT INTO t SELECT 1")), 400)

    def test_update_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("UPDATE t SET x = 1")), 400)

    def test_delete_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("DELETE FROM t WHERE 1=1")), 400)

    def test_ddl_create_rejected(self):
        self.assertEqual(
            status_of(lambda: guard_read("CREATE TABLE t AS SELECT 1")), 400
        )

    def test_drop_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("DROP TABLE t")), 400)

    def test_grant_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("GRANT SELECT ON t TO u")), 400)

    def test_stacked_statement_rejected(self):
        self.assertEqual(
            status_of(lambda: guard_read("SELECT 1; DROP TABLE t")), 400
        )

    def test_comment_rejected(self):
        self.assertEqual(
            status_of(lambda: guard_read("SELECT 1 -- sneaky")), 400
        )
        self.assertEqual(
            status_of(lambda: guard_read("SELECT /* x */ 1")), 400
        )

    def test_stacked_write_after_select_rejected(self):
        # The classic SSRF/stacked write — a SELECT that smuggles a write after ';'.
        self.assertEqual(
            status_of(lambda: guard_read(
                "SELECT 1; INSERT INTO iceberg.sales.orders SELECT * FROM x"
            )),
            400,
        )

    def test_empty_rejected(self):
        self.assertEqual(status_of(lambda: guard_read("")), 400)
        self.assertEqual(status_of(lambda: guard_read("   ")), 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)

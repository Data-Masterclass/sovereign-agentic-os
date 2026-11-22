/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The tables that exist in Trino are read from Trino (ownership rule: Trino owns tables
 *             created in it)
 * USER STORY: As a platform engineer I create a table directly in Trino and expect the OS to see it.
 * ARCHITECTURE: `iceberg.information_schema.tables` through an injected governed query; an unreachable
 *             Trino is `ok:false`, never an empty list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES_SQL, readIcebergTables } from '@core/adapters/trino/tables';

test('reads schema and table names from the iceberg information_schema', async () => {
  const seen: string[] = [];
  const r = await readIcebergTables(async (sql) => { seen.push(sql); return { rows: [['sales', 'gold_x'], ['personal_amir', 'silver_y']] }; });
  assert.deepEqual(seen, [TABLES_SQL]);
  assert.match(TABLES_SQL, /iceberg\.information_schema\.tables/);
  assert.ok(r.ok);
  assert.deepEqual((r as { value: unknown }).value, [{ schema: 'sales', table: 'gold_x' }, { schema: 'personal_amir', table: 'silver_y' }]);
});

test('twin: an unreachable Trino is a failure, not an empty table list', async () => {
  const r = await readIcebergTables(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ok, false);
});

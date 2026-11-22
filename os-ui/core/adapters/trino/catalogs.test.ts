/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino catalogs are read live from Trino (ownership rule: Trino and the chart own catalogs)
 * USER STORY: As a platform engineer I add a catalog in the chart and expect the OS to list it as a
 *             data source without a redeploy, and to say so when it is unreachable.
 * ARCHITECTURE: `SELECT catalog_name FROM system.metadata.catalogs` (Trino's documented system
 *             table) through an injected query function; the `system` catalog is Trino's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGS_SQL, readTrinoCatalogs } from '@core/adapters/trino/catalogs';

test('reads catalog names from system.metadata.catalogs, sorted, without Trino\'s own system catalog', async () => {
  const seen: string[] = [];
  const r = await readTrinoCatalogs(async (sql) => { seen.push(sql); return { rows: [['iceberg'], ['system'], ['sales_pg'], ['jmx']] }; });
  assert.deepEqual(seen, [CATALOGS_SQL]);
  assert.match(CATALOGS_SQL, /system\.metadata\.catalogs/);
  assert.deepEqual(r, { ok: true, value: ['iceberg', 'jmx', 'sales_pg'] });
});

test('twin: an unreachable Trino is a failure, never an empty catalog list', async () => {
  const r = await readTrinoCatalogs(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /ECONNREFUSED/);
});

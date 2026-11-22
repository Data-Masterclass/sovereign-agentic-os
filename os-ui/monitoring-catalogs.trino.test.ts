/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS reads the catalogs a real Trino serves and flags a connection whose catalog is gone
 * USER STORY: As a platform engineer I trust that the Data sources list is what Trino itself answers.
 * ARCHITECTURE: lives beside `monitoring-sources.ts` (the one place allowed to know several tabs); runs on the lakehouse harness (tests/lakehouse: the chart's Trino 476). The query goes
 *   to Trino through the harness client; the OS code under test is `readTrinoCatalogs` and
 *   `dataSourceRows`. Negative twins: a catalog Trino does not serve is not listed, and a connection
 *   pointing at it is the warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTrinoCatalogs } from '@core/adapters/trino/catalogs';
import { dataSourceRows } from '@tabs/monitoring/lib/data-sources-core';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../tests/lakehouse/lib.mjs';

const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';
const trino = (sql: string): Promise<{ rows: unknown[][] }> => run(sql, { user: 'it_catalogs', source: 'os-ui-it' });

test('the catalogs Trino answers are what the OS lists; `system` is left out; a connection to a missing catalog is flagged', { skip }, async () => {
  const direct = (await trino('SHOW CATALOGS')).rows.map((r) => String(r[0]));
  const r = await readTrinoCatalogs(trino);
  assert.ok(r.ok, JSON.stringify(r));
  const listed = (r as { value: string[] }).value;
  assert.ok(listed.includes('iceberg'), `iceberg is the chart's catalog, got ${listed.join(',')}`);
  assert.ok(!listed.includes('system'));
  // Everything the OS lists, Trino itself lists (plain SHOW CATALOGS): the list is not invented.
  for (const c of listed) assert.ok(direct.includes(c), `${c} is not in SHOW CATALOGS`);
  assert.ok(!listed.includes('no_such_catalog_xyz'));

  const ds = dataSourceRows(listed, [{ catalog: 'no_such_catalog_xyz', connectionId: 'c_missing', name: 'Missing', domain: 'sales' }]);
  assert.equal(ds.alerts.length, 1);
  assert.match(ds.alerts[0].detail, /no_such_catalog_xyz/);
  assert.deepEqual(dataSourceRows(listed, [{ catalog: 'iceberg', connectionId: 'c_ice', name: 'Ice', domain: 'sales' }]).alerts, []);
});

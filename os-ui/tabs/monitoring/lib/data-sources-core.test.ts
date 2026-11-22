/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino catalogs shown as data sources, with the OS connection that uses each
 * USER STORY: As a platform admin I see every catalog Trino serves, which OS connection uses it, and
 *             a connection whose catalog Trino no longer serves.
 * ARCHITECTURE: pure over Trino's catalog names and the OS connections' catalogs. A catalog that no
 *             connection uses is information (the chart owns it); a connection without its catalog
 *             is a warning (the OS cannot read through it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataSourceRows } from '@tabs/monitoring/lib/data-sources-core';

const conn = (catalog: string, id = `c_${catalog}`, name = `Conn ${catalog}`) => ({ catalog, connectionId: id, name, domain: 'sales' });

test('each Trino catalog is a data source; one an OS connection uses names the connection', () => {
  const r = dataSourceRows(['iceberg', 'sales_pg', 'tpch'], [conn('sales_pg')]);
  assert.deepEqual(r.rows.map((x) => [x.catalog, x.connection?.connectionId ?? null, x.origin]), [
    ['iceberg', null, 'platform'], ['sales_pg', 'c_sales_pg', 'os-connection'], ['tpch', null, 'platform'],
  ]);
});

test('a connection whose catalog Trino does not serve is a warning naming the connection', () => {
  const r = dataSourceRows(['iceberg'], [conn('gone_pg')]);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].severity, 'warning');
  assert.match(r.alerts[0].detail, /gone_pg/);
  assert.match(r.alerts[0].detail, /Conn gone_pg/);
});

test('twin: a catalog only the platform team added raises nothing, and a matching catalog raises nothing', () => {
  assert.deepEqual(dataSourceRows(['iceberg', 'extra'], [conn('iceberg')]).alerts, []);
});

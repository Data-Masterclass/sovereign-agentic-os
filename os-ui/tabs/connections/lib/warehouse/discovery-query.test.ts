/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showTablesQuery } from '@tabs/connections/lib/warehouse/discovery-query';
import { snowflakeProvider } from '@tabs/connections/lib/warehouse/providers/snowflake';
import { bigqueryProvider } from '@tabs/connections/lib/warehouse/providers/bigquery';
import { databricksProvider } from '@tabs/connections/lib/warehouse/providers/databricks';
import { glueProvider } from '@tabs/connections/lib/warehouse/providers/glue';
import { fabricProvider } from '@tabs/connections/lib/warehouse/providers/fabric';
import { WarehouseError, type WarehouseSource } from '@tabs/connections/lib/warehouse/types';

const glueSrc: WarehouseSource = { catalog: 'glue_sales', platform: 'glue', region: 'eu-central-1' };

test('showTablesQuery renders a validated SHOW TABLES FROM <catalog>.<schema>', () => {
  assert.equal(showTablesQuery(glueSrc, 'sales'), 'SHOW TABLES FROM glue_sales.sales');
});

test('showTablesQuery rejects a malformed schema (injection-safe)', () => {
  for (const bad of ['', ' ', 'sales; DROP TABLE x', 'sa les', '1sales', 'sales"']) {
    assert.throws(() => showTablesQuery(glueSrc, bad), (e: unknown) => e instanceof WarehouseError);
  }
});

test('every SQL-probe provider exposes discoverTables and validates the schema', () => {
  const src: Record<string, WarehouseSource> = {
    snowflake: { catalog: 'sf_sales', platform: 'snowflake', accountUrl: 'ACME-PROD', database: 'DB', warehouse: 'WH', username: 'u' } as WarehouseSource,
    bigquery: { catalog: 'bq_sales', platform: 'bigquery', projectId: 'proj' } as WarehouseSource,
    databricks: { catalog: 'dbx_sales', platform: 'databricks-delta', host: 'https://dbc.cloud.databricks.com', storage: 's3://bucket/x' } as WarehouseSource,
    glue: glueSrc,
  };
  const providers = {
    snowflake: snowflakeProvider,
    bigquery: bigqueryProvider,
    databricks: databricksProvider,
    glue: glueProvider,
  };
  for (const [name, p] of Object.entries(providers)) {
    assert.ok(typeof p.discoverTables === 'function', `${name} must expose discoverTables`);
    const q = p.discoverTables!(src[name], 'public');
    assert.match(q, /^SHOW TABLES FROM \w+\.public$/, `${name} renders SHOW TABLES`);
    // The schema guard is wired through for every provider.
    assert.throws(() => p.discoverTables!(src[name], 'bad;drop'), (e: unknown) => e instanceof WarehouseError);
  }
});

test('fabric is honestly NOT discoverable — no discoverTables method (no metastore)', () => {
  assert.equal(fabricProvider.discoverTables, undefined);
  // And it keeps the `none` test probe that documents why.
  assert.equal(fabricProvider.testProbe.kind, 'none');
});

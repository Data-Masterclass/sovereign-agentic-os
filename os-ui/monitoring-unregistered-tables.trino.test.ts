/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A table created directly in a real Trino is flagged; a table a dataset registers is not
 * USER STORY: As a domain admin I trust that the shadow-table alert is what Trino itself lists.
 * ARCHITECTURE: runs on the lakehouse harness (the chart's Trino 476 + OPA + Polaris). It lives beside `monitoring-sources.ts`, the one place allowed to know every tab. The owner
 *   creates two tables in their personal lane by plain SQL; one is registered through the OS store
 *   (a dataset whose lane table it is), the other is not. The OS code under test is
 *   `readIcebergTables`, the Monitoring source's `registeredTables` (real `footprint`) and
 *   `unregisteredTableAlerts`.
 *   Negative twin: the registered table is not flagged, so the alert is not "everything".
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, getDataset, type Principal } from '@tabs/data/lib/store';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import { monitoringSourcesImpl } from './monitoring-sources';
import { laneTable, personalSchema } from '@tabs/data/lib/store-fqn';
import { readIcebergTables } from '@core/adapters/trino/tables';
import { unregisteredTableAlerts } from '@tabs/monitoring/lib/unregistered-tables-core';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../tests/lakehouse/lib.mjs';

const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';
const trino = (sql: string, user: string): Promise<{ rows: unknown[][] }> => run(sql, { user, source: 'os-ui-it' });

const sfx = Date.now().toString(36);
const OWNER = `it_unreg_${sfx}`;
const DOM = `it-unreg-dom-${sfx}`;
const owner: Principal = { id: OWNER, domains: [DOM], role: 'creator' };
const SCHEMA = personalSchema(OWNER);

beforeEach(() => __resetStore());
before(async () => {
  if (skip) return;
  await trino(`CREATE SCHEMA IF NOT EXISTS iceberg.${SCHEMA}`, OWNER);
});

test('a table made by plain SQL that no dataset registers is flagged; the registered lane table is not', { skip }, async () => {
  const d = createDataset(owner, { name: 'Registered One', domain: DOM });
  const registeredTable = laneTable(getDataset(d.id, owner), 'bronze');
  await trino(`CREATE TABLE iceberg.${SCHEMA}.${registeredTable} AS SELECT 1 AS n`, OWNER);
  await trino(`CREATE TABLE iceberg.${SCHEMA}.hand_made_scratch AS SELECT 2 AS n`, OWNER);
  // OS-internal twin: the merge staging table the sync leaves behind (`<table>_stg`) is the OS's.
  await trino(`CREATE TABLE iceberg.${SCHEMA}.${registeredTable}_stg AS SELECT 3 AS n`, OWNER);

  const physical = await readIcebergTables((sql) => trino(sql, OWNER));
  assert.ok(physical.ok, JSON.stringify(physical));
  const tables = (physical as { value: { schema: string; table: string }[] }).value.filter((t) => t.schema === SCHEMA);
  assert.deepEqual(tables.map((t) => t.table).sort(), ['hand_made_scratch', registeredTable, `${registeredTable}_stg`].sort());

  // The registered side is what the Monitoring source hands over: the real footprint of the store.
  __setDataProjectGitForTests(false); // no Dagster in this harness: there are no dbt-managed tables to exclude
  const reg = await monitoringSourcesImpl.registeredTables();
  assert.deepEqual(reg.managedNames, []);
  const alerts = unregisteredTableAlerts(tables, new Set(reg.fqns), { domainSchemas: [], personalSchemaPrefix: 'personal_', managedNames: new Set(reg.managedNames ?? []) });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /hand_made_scratch/);
  assert.doesNotMatch(alerts[0].detail, new RegExp(registeredTable), 'neither the registered table nor its staging table is flagged');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tables created directly in Trino and unknown to the OS raise an alert
 * USER STORY: As a domain admin I am told about a table in my domain's schema that no dataset
 *             registers, with the way to register it, instead of a shadow table nobody governs.
 * ARCHITECTURE: pure over the physical tables Trino lists and the registered footprint. Only the
 *             domains' schemas and personal lanes are judged; dlt landing schemas, Iceberg system
 *             tables (`name$snapshots`) and other schemas are not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unregisteredTableAlerts, managedTablesOf } from '@tabs/monitoring/lib/unregistered-tables-core';

const t = (schema: string, table: string) => ({ schema, table });
const registered = new Set(['sales.gold_orders', 'personal_amir.silver_orders']);
const judged = { domainSchemas: ['sales'], personalSchemaPrefix: 'personal_', managedTables: new Set<string>() };

test('a table in a domain schema that no dataset registers is one warning per schema, naming the table', () => {
  const a = unregisteredTableAlerts([t('sales', 'gold_orders'), t('sales', 'scratch_tmp'), t('sales', 'oops')], registered, judged);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.equal(a[0].domain, 'sales');
  assert.match(a[0].detail, /scratch_tmp/);
  assert.match(a[0].detail, /oops/);
  assert.doesNotMatch(a[0].detail, /gold_orders/);
  assert.match(a[0].detail, /register/i);
});

test('personal lanes are judged too, and the alert belongs to the lane owner', () => {
  const a = unregisteredTableAlerts([t('personal_amir', 'silver_orders'), t('personal_amir', 'hand_made')], registered, judged);
  assert.equal(a.length, 1);
  assert.equal(a[0].owner, 'amir');
});

test('twin: registered tables, landing schemas, iceberg metadata tables and foreign schemas raise nothing', () => {
  const a = unregisteredTableAlerts(
    [t('sales', 'gold_orders'), t('personal_amir', 'silver_orders'), t('landing_sales_amir', 'raw_orders'), t('sales', 'gold_orders$snapshots'), t('other_schema', 'x')],
    registered, judged,
  );
  assert.deepEqual(a, []);
});

test('twin: OS-internal tables give no warning: a merge staging table of a registered table, and a table Dagster manages as a dbt model', () => {
  const a = unregisteredTableAlerts(
    [t('sales', 'gold_orders_stg'), t('sales', 'int_orders_cleaned'), t('sales', 'gold_orders')],
    registered,
    { ...judged, managedTables: new Set(['sales.int_orders_cleaned']) },
  );
  assert.deepEqual(a, []);
});

test('a staging-looking name whose base table is NOT registered is still flagged, and so is a model-looking name Dagster does not manage', () => {
  const a = unregisteredTableAlerts([t('sales', 'mystery_stg'), t('sales', 'int_other')], registered, { ...judged, managedTables: new Set(['sales.int_orders_cleaned']) });
  assert.equal(a.length, 1);
  assert.match(a[0].detail, /mystery_stg/);
  assert.match(a[0].detail, /int_other/);
});

test('managed tables are matched on schema AND table: the same bare name in another schema is still flagged', () => {
  const a = unregisteredTableAlerts(
    [t('sales', 'int_orders_cleaned'), t('personal_amir', 'int_orders_cleaned'), t('sales', 'other')],
    registered,
    { ...judged, managedTables: new Set(['sales.int_orders_cleaned']) },
  );
  assert.deepEqual(a.map((x) => x.id), ['al-unregistered-tables-personal_amir', 'al-unregistered-tables-sales']);
  const sales = a.find((x) => x.id.endsWith('-sales'))!;
  assert.match(sales.detail, /other/);
  assert.doesNotMatch(sales.detail, /int_orders_cleaned/, 'the managed table in its own schema is not flagged');
  assert.match(a.find((x) => x.id.endsWith('personal_amir'))!.detail, /int_orders_cleaned/);
});

test('managedTablesOf turns Dagster asset keys into schema.table: three-part keys carry the schema, two-part keys use the domain schema', () => {
  const s = managedTablesOf([['sales', 'personal_alice', 'gold_shop_orders'], ['sales', 'int_orders']], (d) => `${d}_schema`);
  assert.deepEqual([...s].sort(), ['personal_alice.gold_shop_orders', 'sales_schema.int_orders']);
  assert.deepEqual([...managedTablesOf([['lonely']], (d) => d)], [], 'a key with no table part names nothing');
});

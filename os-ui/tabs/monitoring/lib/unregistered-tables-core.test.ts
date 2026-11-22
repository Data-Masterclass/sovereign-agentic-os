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
import { unregisteredTableAlerts } from '@tabs/monitoring/lib/unregistered-tables-core';

const t = (schema: string, table: string) => ({ schema, table });
const registered = new Set(['sales.gold_orders', 'personal_amir.silver_orders']);
const judged = { domainSchemas: ['sales'], personalSchemaPrefix: 'personal_' };

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

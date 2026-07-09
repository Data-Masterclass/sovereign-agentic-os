/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPlan, dropPhysicalTables } from './physical-delete.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import type { Principal } from './store.ts';
import type { ExecuteIdentity } from '@/lib/infra/governed';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function ds(over: Partial<Dataset> = {}): Dataset {
  return {
    version: '1', id: 'ds_x', name: 'Web Orders', owner: 'amir', domain: 'sales',
    tier: 'dataset', visibility: 'private', description: '', versions: emptyVersions(),
    grants: [], measures: [], columns: [],
    ...over,
  };
}

test('dropPlan: personal dataset → one personal-lane DROP per BUILT layer only', () => {
  const d = ds();
  d.versions.bronze.built = true;
  d.versions.silver.built = true; // gold NOT built
  const plan = dropPlan(d);
  assert.deepEqual(plan.map((p) => p.fqn), [
    'iceberg.personal_amir.bronze_web_orders',
    'iceberg.personal_amir.silver_web_orders',
  ]);
});

test('dropPlan: nothing built → nothing to drop', () => {
  assert.deepEqual(dropPlan(ds()), []);
});

test('dropPlan: governed asset also drops the (sanitized) domain-schema copies', () => {
  const d = ds({ tier: 'asset', domain: 'sales-emea', visibility: 'domain' });
  d.versions.silver.built = true;
  const plan = dropPlan(d).map((p) => p.fqn);
  assert.deepEqual(plan, [
    'iceberg.personal_amir.silver_web_orders', // the owner's build lane
    'iceberg.sales_emea.silver_web_orders', // the published copy (hyphen sanitized)
  ]);
});

test('dropPhysicalTables issues governed DROPs — personal lane AS the uid, domain lane AS the domain principal', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain' });
  d.versions.gold.built = true;
  const calls: { sql: string; identity: ExecuteIdentity }[] = [];
  const report = await dropPhysicalTables(d, amir, async (sql, identity) => { calls.push({ sql, identity }); });

  assert.deepEqual(calls.map((c) => c.sql), [
    'drop table if exists iceberg.personal_amir.gold_web_orders',
    'drop table if exists iceberg.sales.gold_web_orders',
  ]);
  assert.equal(calls[0].identity.principal, 'amir', 'personal-lane drop runs as the uid (owner-only schema)');
  assert.equal(calls[1].identity.principal, 'sales', 'domain-lane drop runs as the domain principal');
  assert.equal(calls[0].identity.uid, 'amir');
  assert.deepEqual(report.dropped, [
    'iceberg.personal_amir.gold_web_orders',
    'iceberg.sales.gold_web_orders',
  ]);
  assert.deepEqual(report.orphaned, []);
});

test('a failed drop is reported as an ORPHAN (honest), and never blocks the other drops', async () => {
  const d = ds();
  d.versions.bronze.built = true;
  d.versions.silver.built = true;
  const report = await dropPhysicalTables(d, amir, async (sql) => {
    if (sql.includes('bronze_')) throw new Error('Could not reach query-tool');
  });
  assert.deepEqual(report.dropped, ['iceberg.personal_amir.silver_web_orders']);
  assert.equal(report.orphaned.length, 1);
  assert.equal(report.orphaned[0].fqn, 'iceberg.personal_amir.bronze_web_orders');
  assert.match(report.orphaned[0].reason, /query-tool/);
});

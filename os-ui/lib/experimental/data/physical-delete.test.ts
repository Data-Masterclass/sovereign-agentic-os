/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPlan, dropPhysicalTables, domainDropPlan, retireDomainTables, sharedFootprintFqns } from './physical-delete.ts';
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

// ── DEMOTE-RETIRE (zombie-asset fix): dropping ONLY the domain copies on an unshare ──

test('domainDropPlan: only the DOMAIN copies of built layers — never the personal lane', () => {
  const d = ds({ tier: 'asset', domain: 'sales-emea', visibility: 'domain' });
  d.versions.silver.built = true;
  d.versions.gold.built = true;
  assert.deepEqual(domainDropPlan(d).map((p) => p.fqn), [
    'iceberg.sales_emea.silver_web_orders',
    'iceberg.sales_emea.gold_web_orders',
  ]);
});

test('retireDomainTables drops the domain copies AS the domain principal (owner build untouched)', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain' });
  d.versions.gold.built = true;
  const calls: { sql: string; identity: ExecuteIdentity }[] = [];
  const report = await retireDomainTables(d, amir, async (sql, identity) => { calls.push({ sql, identity }); });
  assert.deepEqual(calls.map((c) => c.sql), ['drop table if exists iceberg.sales.gold_web_orders']);
  assert.equal(calls[0].identity.principal, 'sales', 'domain-lane drop runs as the domain principal');
  assert.deepEqual(report.dropped, ['iceberg.sales.gold_web_orders']);
  assert.deepEqual(report.orphaned, []);
});

test('promote-as-view: demote DROPS the VIEW (not the table), owner personal lane untouched', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain', domainArtifact: 'view' });
  d.versions.gold.built = true;
  // The plan targets the domain copy as a view object.
  const plan = domainDropPlan(d);
  assert.deepEqual(plan.map((p) => ({ fqn: p.fqn, object: p.object })), [
    { fqn: 'iceberg.sales.gold_web_orders', object: 'view' },
  ]);
  const calls: string[] = [];
  const report = await retireDomainTables(d, amir, async (sql) => { calls.push(sql); });
  assert.deepEqual(calls, ['drop view if exists iceberg.sales.gold_web_orders']);
  assert.deepEqual(report.dropped, ['iceberg.sales.gold_web_orders']);
  // The domain drop plan never references the owner's personal lane (untouched by design).
  assert.ok(!calls.some((c) => c.includes('personal_')));
});

test('promote-as-view: DELETE drops the personal TABLE + the domain VIEW (right object each)', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain', domainArtifact: 'view' });
  d.versions.gold.built = true;
  const calls: string[] = [];
  await dropPhysicalTables(d, amir, async (sql) => { calls.push(sql); });
  assert.deepEqual(calls, [
    'drop table if exists iceberg.personal_amir.gold_web_orders', // the owner's real build lane
    'drop view if exists iceberg.sales.gold_web_orders', // the governed view
  ]);
});

// ── COLLISION GUARD (data-loss): protect a table a live sibling still occupies ──

test('sharedFootprintFqns: a same-slug promoted sibling in the domain collides on the domain FQN', () => {
  const target = ds({ id: 'ds_a', tier: 'asset', domain: 'sales', visibility: 'domain' });
  target.versions.gold.built = true;
  // Different id, SAME name → same slug → same domain gold table.
  const sibling = ds({ id: 'ds_b', tier: 'asset', domain: 'sales', visibility: 'domain', owner: 'other' });
  sibling.versions.gold.built = true;
  const fqns = sharedFootprintFqns(target, [target, sibling]);
  assert.ok(fqns.has('iceberg.sales.gold_web_orders'), 'the shared domain table is protected');
  // The sibling's OWN personal lane (different owner) is not the target's, but is still in the set.
  assert.ok(fqns.has('iceberg.personal_other.gold_web_orders'));
});

test('sharedFootprintFqns: no collision → empty set', () => {
  const target = ds({ id: 'ds_a', tier: 'asset', domain: 'sales', name: 'Orders A', visibility: 'domain' });
  target.versions.gold.built = true;
  const other = ds({ id: 'ds_b', tier: 'asset', domain: 'sales', name: 'Orders B', owner: 'zoe', visibility: 'domain' });
  other.versions.gold.built = true;
  const fqns = sharedFootprintFqns(target, [target, other]);
  assert.ok(!fqns.has('iceberg.sales.gold_orders_a'), 'the target FQN is NOT protected by a differently-named dataset');
});

test('sharedFootprintFqns: an archived sibling holds no live claim → excluded', () => {
  const target = ds({ id: 'ds_a', tier: 'asset', domain: 'sales', visibility: 'domain' });
  target.versions.gold.built = true;
  const archived = { ...ds({ id: 'ds_b', tier: 'asset', domain: 'sales', visibility: 'domain' }), archived: true };
  archived.versions = target.versions; // built too
  const fqns = sharedFootprintFqns(target, [target, archived]);
  assert.equal(fqns.size, 0);
});

test('retireDomainTables SKIPS a protected FQN (orphaned w/ collision reason) and still drops the rest', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain' });
  d.versions.silver.built = true;
  d.versions.gold.built = true;
  const protectedFqns = new Set(['iceberg.sales.gold_web_orders']); // shared by a sibling
  const calls: string[] = [];
  const report = await retireDomainTables(d, amir, async (sql) => { calls.push(sql); }, protectedFqns);
  // Only the non-protected silver table is actually dropped.
  assert.deepEqual(calls, ['drop table if exists iceberg.sales.silver_web_orders']);
  assert.deepEqual(report.dropped, ['iceberg.sales.silver_web_orders']);
  assert.equal(report.orphaned.length, 1);
  assert.equal(report.orphaned[0].fqn, 'iceberg.sales.gold_web_orders');
  assert.match(report.orphaned[0].reason, /still shared by another dataset/);
});

test('dropPhysicalTables SKIPS a protected FQN and still drops the non-protected ones', async () => {
  const d = ds({ tier: 'asset', domain: 'sales', visibility: 'domain' });
  d.versions.gold.built = true; // personal + domain gold
  const protectedFqns = new Set(['iceberg.sales.gold_web_orders']);
  const calls: string[] = [];
  const report = await dropPhysicalTables(d, amir, async (sql) => { calls.push(sql); }, protectedFqns);
  assert.deepEqual(calls, ['drop table if exists iceberg.personal_amir.gold_web_orders']);
  assert.deepEqual(report.dropped, ['iceberg.personal_amir.gold_web_orders']);
  assert.equal(report.orphaned.length, 1);
  assert.equal(report.orphaned[0].fqn, 'iceberg.sales.gold_web_orders');
  assert.match(report.orphaned[0].reason, /name\/slug collision/);
});

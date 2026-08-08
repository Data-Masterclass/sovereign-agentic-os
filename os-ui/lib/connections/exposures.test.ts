/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Exposure-set CRUD + the admin-only role gate (lakehouse Expose, Phase 1). Offline:
 * the OpenSearch mirror + trace are unreachable (graceful no-ops), so the in-process
 * registry is authoritative — exactly the store's teaching-mode contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

// Offline-stub every network call (mirror/trace/query-tool) so the registry stays
// in-memory and no test reaches a cluster.
globalThis.fetch = (async () => {
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, __resetConnections } = await import('./store.ts');
const { createExposureSet, updateExposureSet, revokeExposureSet, listExposureSets, allActiveExposures, __resetExposures } =
  await import('./exposures.ts');

const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };
const builder = { id: 'b1', name: 'B', domains: ['sales'], role: 'builder' as const };

async function glueConn(user = admin) {
  return createConnection(user, {
    name: 'Glue sales',
    template: 'warehouse',
    endpoint: '',
    credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
}

function reset() {
  __resetConnections();
  __resetExposures();
}

test('admin creates an exposure set; it lists and appears in the active set', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'Sales → Commerce',
    domains: ['commerce'],
    mode: 'live',
    tier: 'silver',
    tables: [{ schema: 'public', table: 'orders' }],
  });
  assert.equal(e.name, 'Sales → Commerce');
  assert.equal(e.mode, 'live');
  assert.equal(e.revoked, undefined);

  const listed = await listExposureSets(c.id, admin);
  assert.equal(listed.length, 1);
  const active = await allActiveExposures();
  assert.equal(active.length, 1);
});

test('a builder (below admin) is DENIED create/update/revoke (role gate, fail-closed)', async () => {
  reset();
  const c = await glueConn(); // created by admin
  await assert.rejects(
    () => createExposureSet(c.id, builder, { name: 'x', domains: ['commerce'], tables: [{ schema: 's', table: 't' }] }),
    /requires an Administrator/,
  );
  // A set the admin made — the builder still can't mutate it.
  const e = await createExposureSet(c.id, admin, { name: 'x', domains: ['commerce'], tables: [{ schema: 's', table: 't' }] });
  await assert.rejects(() => updateExposureSet(e.id, builder, { name: 'y' }), /requires an Administrator/);
  await assert.rejects(() => revokeExposureSet(e.id, builder), /requires an Administrator/);
});

test('empty tables or empty domains are rejected (an exposure must grant something)', async () => {
  reset();
  const c = await glueConn();
  await assert.rejects(() => createExposureSet(c.id, admin, { name: 'x', domains: ['commerce'], tables: [] }), /at least one table/);
  await assert.rejects(() => createExposureSet(c.id, admin, { name: 'x', domains: [], tables: [{ schema: 's', table: 't' }] }), /at least one domain/);
});

test('update edits domains/tables; revoke removes it from the active set', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, { name: 'x', domains: ['commerce'], tables: [{ schema: 'public', table: 'orders' }] });

  const up = await updateExposureSet(e.id, admin, { domains: ['commerce', 'marketing'], tables: [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'refunds' }] });
  assert.deepEqual(up.domains, ['commerce', 'marketing']);
  assert.equal(up.tables.length, 2);

  const rev = await revokeExposureSet(e.id, admin);
  assert.equal(rev.revoked, true);
  const active = await allActiveExposures();
  assert.equal(active.length, 0);
  // Revoked set still LISTS (admin manage view keeps history).
  const listed = await listExposureSets(c.id, admin);
  assert.equal(listed.length, 1);
});

test('sync mode carries syncDefaults; switching to live drops them', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'x', domains: ['commerce'], mode: 'sync', tables: [{ schema: 's', table: 't' }],
    syncDefaults: { schedule: '0 * * * *' },
  });
  assert.equal(e.syncDefaults?.schedule, '0 * * * *');
  const up = await updateExposureSet(e.id, admin, { mode: 'live' });
  assert.equal(up.syncDefaults, undefined);
});

test('m6: createExposureSet refuses a non-warehouse, non-operational connection', async () => {
  reset();
  // A Gmail (SaaS tool-surface) connection has no adoptable tables — expose must 400.
  const c = await createConnection(admin, { name: 'Gmail', template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'tok' });
  await assert.rejects(
    () => createExposureSet(c.id, admin, {
      name: 'Nope', domains: ['commerce'], mode: 'live', tier: 'silver',
      tables: [{ schema: 'x', table: 'y' }],
    }),
    /warehouse or operational/i,
  );
});

test('m6: an operational (Salesforce) connection CAN expose', async () => {
  reset();
  const c = await createConnection(admin, { name: 'SF', template: 'salesforce-api', endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs' });
  const e = await createExposureSet(c.id, admin, {
    name: 'SF Accounts', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
  });
  assert.equal(e.mode, 'sync'); // operational is forced to sync
});

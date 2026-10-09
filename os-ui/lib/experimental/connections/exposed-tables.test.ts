/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Adopt read-side (lakehouse-import-exposure.md, Phase 2): the domain-intersection view of
 * exposed tables + the adopt resolver. Offline — the mirror/trace are unreachable no-ops so
 * the in-process registries are authoritative (the store's teaching-mode contract).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

globalThis.fetch = (async () => {
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, __resetConnections } = await import('./store.ts');
const { createExposureSet, __resetExposures } = await import('./exposures.ts');
const { listExposedTablesForUser, resolveAdoptableExposure } = await import('./exposed-tables.ts');

const admin = { id: 'a1', name: 'A', domains: ['commerce'], role: 'admin' as const };
// A commerce domain admin (the adoption floor) — only sees exposures shared with commerce.
const commerceAdmin = { id: 'd1', name: 'D', domains: ['commerce'], role: 'domain_admin' as const };
const financeAdmin = { id: 'f1', name: 'F', domains: ['finance'], role: 'domain_admin' as const };

async function glueConn() {
  return createConnection(admin, {
    name: 'Glue sales',
    template: 'warehouse',
    endpoint: '',
    credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
}

async function salesforceConn() {
  return createConnection(admin, {
    name: 'Salesforce prod',
    template: 'salesforce-api',
    endpoint: 'https://acme.my.salesforce.com',
    credential: 'ck:cs',
  });
}

function reset() {
  __resetConnections();
  __resetExposures();
}

test('listExposedTablesForUser: only exposures shared with a caller domain are returned', async () => {
  reset();
  const c = await glueConn();
  await createExposureSet(c.id, admin, {
    name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'silver',
    tables: [{ schema: 'public', table: 'orders' }],
  });
  await createExposureSet(c.id, admin, {
    name: 'Sales → Finance', domains: ['finance'], mode: 'live', tier: 'silver',
    tables: [{ schema: 'public', table: 'ledger' }],
  });

  const forCommerce = await listExposedTablesForUser(commerceAdmin);
  assert.equal(forCommerce.length, 1);
  assert.equal(forCommerce[0].catalog, 'glue_sales');
  assert.equal(forCommerce[0].exposures.length, 1);
  assert.equal(forCommerce[0].exposures[0].name, 'Sales → Commerce');
  assert.deepEqual(forCommerce[0].exposures[0].tables, [{ schema: 'public', table: 'orders' }]);

  // Finance admin never sees the commerce exposure.
  const forFinance = await listExposedTablesForUser(financeAdmin);
  assert.equal(forFinance[0].exposures[0].name, 'Sales → Finance');
});

test('listExposedTablesForUser: a sync-mode exposure is adoptable and carries its syncDefaults (Phase 3)', async () => {
  reset();
  const c = await glueConn();
  await createExposureSet(c.id, admin, {
    name: 'Synced sales', domains: ['commerce'], mode: 'sync', tier: 'gold',
    tables: [{ schema: 'public', table: 'orders' }],
    syncDefaults: { schedule: '0 * * * *', fullRefresh: false },
  });
  const out = await listExposedTablesForUser(commerceAdmin);
  const exp = out[0].exposures[0];
  assert.equal(exp.mode, 'sync');
  assert.equal(exp.adoptable, true);
  assert.equal(exp.deferredReason, undefined);
  assert.deepEqual(exp.syncDefaults, { schedule: '0 * * * *', fullRefresh: false });
});

test('resolveAdoptableExposure: resolves a live exposure to its catalog + intersecting domain', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'gold',
    tables: [{ schema: 'public', table: 'orders' }],
  });
  const res = await resolveAdoptableExposure(e.id, commerceAdmin);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.catalog, 'glue_sales');
    assert.equal(res.domain, 'commerce');
    assert.equal(res.exposure.tier, 'gold');
  }
});

test('resolveAdoptableExposure: refuses an exposure not shared with the caller (403)', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'Sales → Finance', domains: ['finance'], mode: 'live', tier: 'silver',
    tables: [{ schema: 'public', table: 'ledger' }],
  });
  const res = await resolveAdoptableExposure(e.id, commerceAdmin);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 403);
});

test('resolveAdoptableExposure: resolves a sync-mode exposure (Phase 3 — adoptable)', async () => {
  reset();
  const c = await glueConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'Synced', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'public', table: 'orders' }],
  });
  const res = await resolveAdoptableExposure(e.id, commerceAdmin);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.exposure.mode, 'sync');
    assert.equal(res.catalog, 'glue_sales');
    assert.equal(res.domain, 'commerce');
  }
});

// -------------------------------------------------- operational (Phase 2) --------

test('createExposureSet: an operational source is FORCED to sync; explicit live is refused', async () => {
  reset();
  const c = await salesforceConn();
  // Explicit live → honest refusal.
  await assert.rejects(
    () => createExposureSet(c.id, admin, {
      name: 'SF → Commerce', domains: ['commerce'], mode: 'live', tier: 'silver',
      tables: [{ schema: 'salesforce', table: 'Account' }],
    }),
    /Operational sources sync; there is no live mode/,
  );
  // Omitted mode (default) → forced to sync (never live).
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
  });
  assert.equal(e.mode, 'sync');
});

test('listExposedTablesForUser: an operational connection resolves with catalog:null + cursor honesty', async () => {
  reset();
  const c = await salesforceConn();
  await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
  });
  const out = await listExposedTablesForUser(commerceAdmin);
  assert.equal(out.length, 1);
  assert.equal(out[0].catalog, null);
  assert.equal(out[0].operational, true);
  assert.equal(out[0].platform, 'salesforce');
  const t = out[0].exposures[0].tables[0];
  assert.equal(t.cursor?.incremental, true);
  assert.equal(t.cursor?.column, 'SystemModstamp');
  assert.equal(t.cursor?.chip, 'Incremental (SystemModstamp)');
});

test('resolveAdoptableExposure: operational resolves with the platform pseudo-catalog', async () => {
  reset();
  const c = await salesforceConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'SF → Commerce', domains: ['commerce'], mode: 'sync', tier: 'gold',
    tables: [{ schema: 'salesforce', table: 'Account' }],
  });
  const res = await resolveAdoptableExposure(e.id, commerceAdmin);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.operational, true);
    assert.equal(res.platform, 'salesforce');
    assert.equal(res.catalog, 'salesforce'); // pseudo-catalog = platform name
    assert.equal(res.exposure.mode, 'sync');
  }
});

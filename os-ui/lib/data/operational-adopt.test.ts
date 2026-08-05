/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Adopt validation for OPERATIONAL sources (operational-system-connections.md, Phase 2):
 * an operational exposure is sync-only; its cursor is registry-locked (never the caller's
 * to name); a full-refresh-only entity refuses an incremental mode honestly; merge is
 * unavailable (api-batch). Offline — the mirror/trace/k8s are graceful no-ops so the
 * in-process registries are authoritative and CronJob reconciliation is honestly
 * "unreachable" rather than throwing.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

globalThis.fetch = (async () => { throw new Error('offline-stub'); }) as typeof fetch;

const { createConnection, __resetConnections } = await import('@/lib/connections/store');
const { createExposureSet, __resetExposures } = await import('@/lib/connections/exposures');
const { adoptExposedTable } = await import('./adopt-connected.ts');
const { __resetStore } = await import('./store.ts');

const admin = { id: 'a1', name: 'A', domains: ['commerce'], role: 'admin' as const };
const commerceAdmin = { id: 'd1', name: 'D', domains: ['commerce'], allDomains: ['commerce'], activeDomain: null, role: 'domain_admin' as const };

async function salesforceExposure(table: string) {
  const c = await createConnection(admin, {
    name: 'Salesforce prod', template: 'salesforce-api',
    endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs',
  });
  const e = await createExposureSet(c.id, admin, {
    name: `SF ${table}`, domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table }],
  });
  return { c, e };
}

async function kajabiExposure(resource: string) {
  const c = await createConnection(admin, {
    name: 'Kajabi', template: 'kajabi-api', endpoint: 'https://api.kajabi.com', credential: 'id:secret',
  });
  const e = await createExposureSet(c.id, admin, {
    name: `KJ ${resource}`, domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'kajabi', table: resource }],
  });
  return { c, e };
}

beforeEach(() => { __resetConnections(); __resetExposures(); __resetStore(); });

test('operational adopt: records connected.source with the platform pseudo-catalog, sync forced', async () => {
  const { e } = await salesforceExposure('Account');
  const { dataset } = await adoptExposedTable(commerceAdmin, {
    exposureId: e.id, schema: 'salesforce', table: 'Account',
    description: 'Salesforce accounts, synced.',
    sync: { mode: 'full-refresh' },
  });
  assert.equal(dataset.origin, 'connected');
  assert.equal(dataset.connected?.mode, 'sync');
  assert.deepEqual(dataset.connected?.source, { catalog: 'salesforce', schema: 'salesforce', table: 'Account' });
  assert.equal(dataset.sync?.mode, 'full-refresh');
});

test('operational adopt: an incremental mode locks the cursor to the registry column', async () => {
  const { e } = await salesforceExposure('Account');
  const { dataset } = await adoptExposedTable(commerceAdmin, {
    exposureId: e.id, schema: 'salesforce', table: 'Account',
    description: 'Salesforce accounts, incremental.',
    // The caller "asks" for a bogus cursor column — it is IGNORED; the registry owns it.
    sync: { mode: 'append', cursor: { kind: 'timestamp', column: 'not_a_real_column' } },
  });
  assert.equal(dataset.sync?.mode, 'append');
  assert.equal(dataset.sync?.cursor?.column, 'SystemModstamp');
});

test('operational adopt: a full-refresh-only entity refuses an incremental mode honestly', async () => {
  const { e } = await kajabiExposure('offers'); // offers carry no timestamps → full refresh only
  await assert.rejects(
    () => adoptExposedTable(commerceAdmin, {
      exposureId: e.id, schema: 'kajabi', table: 'offers',
      description: 'Kajabi offers.', sync: { mode: 'append' },
    }),
    /full refresh only/i,
  );
  // Full refresh IS accepted for the same entity.
  const { dataset } = await adoptExposedTable(commerceAdmin, {
    exposureId: e.id, schema: 'kajabi', table: 'offers',
    description: 'Kajabi offers.', sync: { mode: 'full-refresh' },
  });
  assert.equal(dataset.sync?.mode, 'full-refresh');
});

test('operational adopt: merge (update-by-key) is refused for an api-batch source', async () => {
  const { e } = await salesforceExposure('Account');
  await assert.rejects(
    () => adoptExposedTable(commerceAdmin, {
      exposureId: e.id, schema: 'salesforce', table: 'Account',
      description: 'x', sync: { mode: 'merge', mergeKeys: ['Id'] },
    }),
    /full refresh or add-new-rows only/i,
  );
});

test('operational adopt: a Kajabi created_at entity locks to created_at', async () => {
  const { e } = await kajabiExposure('contacts'); // documents created_at only
  const { dataset } = await adoptExposedTable(commerceAdmin, {
    exposureId: e.id, schema: 'kajabi', table: 'contacts',
    description: 'Kajabi contacts.', sync: { mode: 'append' },
  });
  assert.equal(dataset.sync?.cursor?.column, 'created_at');
});

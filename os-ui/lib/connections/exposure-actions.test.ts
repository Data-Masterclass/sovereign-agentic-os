/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * TWO-LAYER WRITE APPROVAL, enable-time (operational-system-connections.md, Phase 3):
 * create/update on an exposure's actions enqueue an admin `exposure_action_enable`
 * approval; write scopes stay compiled-out (`writeApproved` false) until approved;
 * read/search activate immediately; a broadening edit re-triggers the approval. Flag
 * forced on; offline mirror/trace are no-ops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { operationalActionsEnabled: boolean }).operationalActionsEnabled = true;

globalThis.fetch = (async () => { throw new Error('offline-stub'); }) as typeof fetch;

const { createConnection, __resetConnections } = await import('./store.ts');
const { createExposureSet, updateExposureSet, actionsBroadenWrites, __resetExposures } = await import('./exposures.ts');
const { listApprovals, __resetApprovals } = await import('@/lib/governance/approvals');

const admin = { id: 'a1', name: 'A', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'admin' as const };

async function sfConn() {
  return createConnection(admin, { name: 'SF', template: 'salesforce-api', endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs' });
}
function reset() { __resetConnections(); __resetExposures(); __resetApprovals(); }

test('read-only actions activate immediately, no approval enqueued', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'read', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, search: true } },
  });
  assert.equal(e.writeApproved, undefined, 'no write requested ⇒ no approval flag');
  assert.equal(listApprovals({ status: 'pending' }).filter((a) => a.kind === 'exposure_action_enable').length, 0);
});

test('create/update actions enqueue exposure_action_enable and stay writeApproved:false', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'write', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { read: true, create: true } },
  });
  assert.equal(e.writeApproved, false, 'write requested ⇒ compiled-out until approved');
  const pend = listApprovals({ status: 'pending' }).filter((a) => a.kind === 'exposure_action_enable');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].approverRole, 'admin');
  assert.equal(pend[0].scope, 'tenant');
});

test('BROADENING an approved write set re-triggers the approval (writeApproved cleared)', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'write', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }, { schema: 'salesforce', table: 'Opportunity' }],
    actions: { account: { create: true } },
  });
  // Simulate the admin approval having landed.
  const { approveExposureActions } = await import('./exposures.ts');
  await approveExposureActions(e.id, admin);
  __resetApprovals(); // clear the first enqueue so we can count the re-trigger cleanly

  // Broaden: add update on account + create on opportunity.
  const e2 = await updateExposureSet(e.id, admin, {
    actions: { account: { create: true, update: true }, opportunity: { create: true } },
  });
  assert.equal(e2.writeApproved, false, 'broadening clears the approval');
  const pend = listApprovals({ status: 'pending' }).filter((a) => a.kind === 'exposure_action_enable');
  assert.equal(pend.length, 1, 'broadening re-enqueues one approval');
});

test('a NON-broadening (narrowing / read-only) edit keeps prior approval', async () => {
  reset();
  const c = await sfConn();
  const e = await createExposureSet(c.id, admin, {
    name: 'write', domains: ['commerce'], mode: 'sync', tier: 'silver',
    tables: [{ schema: 'salesforce', table: 'Account' }],
    actions: { account: { create: true, update: true } },
  });
  const { approveExposureActions } = await import('./exposures.ts');
  await approveExposureActions(e.id, admin);
  __resetApprovals();

  // Drop `update` (narrow), keep create → NOT a broadening.
  const e2 = await updateExposureSet(e.id, admin, { actions: { account: { create: true } } });
  assert.equal(e2.writeApproved, true, 'narrowing keeps the standing approval');
  assert.equal(listApprovals({ status: 'pending' }).filter((a) => a.kind === 'exposure_action_enable').length, 0);
});

test('actionsBroadenWrites: pure detector', () => {
  assert.equal(actionsBroadenWrites({ a: { create: true } }, { a: { create: true } }), false);
  assert.equal(actionsBroadenWrites({ a: { create: true } }, { a: { create: true, update: true } }), true);
  assert.equal(actionsBroadenWrites(undefined, { a: { create: true } }), true);
  assert.equal(actionsBroadenWrites({ a: { create: true } }, { a: { read: true } }), false, 'dropping a write is not broadening');
});

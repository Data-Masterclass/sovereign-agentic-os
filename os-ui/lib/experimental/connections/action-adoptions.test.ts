/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * DOMAIN ACTION ADOPTION (operational-system-connections.md, Phase 3): the domain-consent
 * store. domain_admin-of-target-domain gate, supersede-on-readopt, soft revoke, and the
 * pure `adoptionCovers` predicate. Offline mirror/trace are no-ops.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => { throw new Error('offline-stub'); }) as typeof fetch;

const { createConnection, __resetConnections } = await import('./store.ts');
const { adoptActions, revokeActionAdoption, listAdoptions, allActiveAdoptions, adoptionCovers, __resetActionAdoptions } =
  await import('./action-adoptions.ts');

const admin = { id: 'a1', name: 'A', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'admin' as const };
const commerceAdmin = { id: 'd1', name: 'D', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'domain_admin' as const };
const financeAdmin = { id: 'f1', name: 'F', domains: ['finance'], activeDomain: 'finance', allDomains: ['finance'], role: 'domain_admin' as const };
const builder = { id: 'b1', name: 'B', domains: ['commerce'], activeDomain: 'commerce', allDomains: ['commerce'], role: 'builder' as const };

async function sfConn() {
  return createConnection(admin, { name: 'SF', template: 'salesforce-api', endpoint: 'https://acme.my.salesforce.com', credential: 'ck:cs' });
}
function reset() { __resetConnections(); __resetActionAdoptions(); }

test('adopt: a domain_admin of the target domain adopts; entities lowercased', async () => {
  reset();
  const c = await sfConn();
  const a = await adoptActions(c.id, commerceAdmin, { exposureId: 'exp1', domain: 'commerce', entities: ['Account', 'OPPORTUNITY'] });
  assert.deepEqual(a.entities.sort(), ['account', 'opportunity']);
  assert.equal((await listAdoptions('exp1')).length, 1);
  assert.ok(adoptionCovers(await allActiveAdoptions(), 'exp1', 'commerce', 'Account'));
});

test('adopt gate: a builder / a foreign-domain admin is denied', async () => {
  reset();
  const c = await sfConn();
  await assert.rejects(() => adoptActions(c.id, builder, { exposureId: 'e', domain: 'commerce', entities: ['account'] }), /domain administrator/);
  await assert.rejects(() => adoptActions(c.id, financeAdmin, { exposureId: 'e', domain: 'commerce', entities: ['account'] }), /domain administrator/);
});

test('readopt supersedes the prior non-revoked adoption for the same exposure+domain', async () => {
  reset();
  const c = await sfConn();
  await adoptActions(c.id, commerceAdmin, { exposureId: 'exp1', domain: 'commerce', entities: ['account'] });
  await adoptActions(c.id, commerceAdmin, { exposureId: 'exp1', domain: 'commerce', entities: ['account', 'contact'] });
  const active = (await allActiveAdoptions()).filter((x) => x.exposureId === 'exp1');
  assert.equal(active.length, 1, 'only the latest is active');
  assert.deepEqual(active[0].entities.sort(), ['account', 'contact']);
});

test('revoke: kills coverage immediately', async () => {
  reset();
  const c = await sfConn();
  const a = await adoptActions(c.id, commerceAdmin, { exposureId: 'exp1', domain: 'commerce', entities: ['account'] });
  await revokeActionAdoption(a.id, commerceAdmin);
  assert.ok(!adoptionCovers(await allActiveAdoptions(), 'exp1', 'commerce', 'account'));
});

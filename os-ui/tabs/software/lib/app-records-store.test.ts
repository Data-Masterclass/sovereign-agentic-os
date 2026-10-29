/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * App-records store tests — the durable OS-side home for `os.records.*`. The
 * boundaries this suite pins:
 *   • add→list round-trip (records persist in the store).
 *   • My vs Domain visibility: owner sees own; a same-domain peer sees Domain
 *     records; an other-domain user does NOT.
 *   • Cross-app isolation: app A's records are invisible under app B.
 *   • export returns the visible set; __resetAppRecordsCache clears state.
 * Pure module (no cluster): the OpenSearch probe fails fast offline, so
 * everything runs in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAppRecord,
  listAppRecords,
  getAppRecord,
  exportAppRecords,
  __resetAppRecordsCache,
  type RecordActor,
} from './app-records-store.ts';

const owner: RecordActor = { id: 'sara', domain: 'sales' };
const peer: RecordActor = { id: 'amir', domain: 'sales' };
const outsider: RecordActor = { id: 'kenji', domain: 'finance' };

test('add→list round-trip: a persisted record comes back to its owner', async () => {
  __resetAppRecordsCache();
  const r = await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'Acme' } });
  const list = await listAppRecords({ appSlug: 'crm', actor: owner });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, r.id);
  assert.deepEqual(list[0].record, { name: 'Acme' });
  assert.equal(list[0].owner, 'sara');
  assert.equal(list[0].domain, 'sales');
});

test('My vs Domain: owner sees own, same-domain peer sees Domain, other-domain user sees nothing', async () => {
  __resetAppRecordsCache();
  await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'Acme' } });

  // Owner (My): sees their own record.
  assert.equal((await listAppRecords({ appSlug: 'crm', actor: owner })).length, 1);
  // Same-domain peer (Domain): the record belongs to their domain, so they see it.
  assert.equal((await listAppRecords({ appSlug: 'crm', actor: peer })).length, 1);
  // Other-domain user: neither My nor Domain → sees nothing.
  assert.equal((await listAppRecords({ appSlug: 'crm', actor: outsider })).length, 0);
});

test('get: visible to owner + same-domain peer, null for an other-domain user', async () => {
  __resetAppRecordsCache();
  const r = await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'Acme' } });
  assert.equal((await getAppRecord({ appSlug: 'crm', id: r.id, actor: owner }))?.id, r.id);
  assert.equal((await getAppRecord({ appSlug: 'crm', id: r.id, actor: peer }))?.id, r.id);
  assert.equal(await getAppRecord({ appSlug: 'crm', id: r.id, actor: outsider }), null);
  // A missing id is null, not an error.
  assert.equal(await getAppRecord({ appSlug: 'crm', id: 'nope', actor: owner }), null);
});

test('ISOLATION: app A records are never visible under app B', async () => {
  __resetAppRecordsCache();
  const a = await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'A' } });
  await addAppRecord({ appSlug: 'billing', owner: owner.id, domain: 'sales', record: { name: 'B' } });

  const crm = await listAppRecords({ appSlug: 'crm', actor: owner });
  assert.equal(crm.length, 1);
  assert.equal(crm[0].record.name, 'A');

  const billing = await listAppRecords({ appSlug: 'billing', actor: owner });
  assert.equal(billing.length, 1);
  assert.equal(billing[0].record.name, 'B');

  // Even by-id: app A's record id is not reachable under app B's slug.
  assert.equal(await getAppRecord({ appSlug: 'billing', id: a.id, actor: owner }), null);
});

test('export returns the visible set (same scope as list)', async () => {
  __resetAppRecordsCache();
  await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'A' } });
  await addAppRecord({ appSlug: 'crm', owner: peer.id, domain: 'sales', record: { name: 'B' } });

  // Both are in-domain, so a same-domain peer exports both.
  assert.equal((await exportAppRecords({ appSlug: 'crm', actor: peer })).length, 2);
  // An other-domain user exports nothing.
  assert.equal((await exportAppRecords({ appSlug: 'crm', actor: outsider })).length, 0);
});

test('__resetAppRecordsCache clears the store', async () => {
  __resetAppRecordsCache();
  await addAppRecord({ appSlug: 'crm', owner: owner.id, domain: 'sales', record: { name: 'A' } });
  assert.equal((await listAppRecords({ appSlug: 'crm', actor: owner })).length, 1);
  __resetAppRecordsCache();
  assert.equal((await listAppRecords({ appSlug: 'crm', actor: owner })).length, 0);
});

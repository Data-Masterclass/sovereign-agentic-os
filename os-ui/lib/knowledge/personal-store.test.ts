/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  listPersonalKnowledge,
  getPersonalKnowledge,
  createPersonalKnowledge,
  updatePersonalKnowledge,
  deletePersonalKnowledge,
  archivePersonalKnowledge,
  unarchivePersonalKnowledge,
  listPersonalKnowledgeVersions,
  restorePersonalKnowledgeVersion,
  promotePersonalKnowledge,
  certifyPersonalKnowledge,
  decertifyPersonalKnowledge,
  unsharePersonalKnowledge,
} from './personal-store.ts';

const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const bea = { id: 'bea', domains: ['sales'], role: 'builder' as const };
// Promoting Personal→Shared now requires domain_admin+; `dana` is the in-domain approver.
const dana = { id: 'dana', domains: ['sales'], role: 'domain_admin' as const };
const kenji = { id: 'kenji', domains: ['finance'], role: 'builder' as const };
const ada = { id: 'ada', domains: ['sales'], role: 'admin' as const };

test('a fresh tenant has no personal knowledge', () => {
  __resetStore();
  const g = listPersonalKnowledge(amir);
  assert.deepEqual([g.mine.length, g.domain.length, g.marketplace.length], [0, 0, 0]);
});

test('create → the entry lands under the owner\'s "mine" group, Personal visibility', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'How I work', md: 'I prefer async.' });
  assert.equal(rec.owner, 'amir');
  assert.equal(rec.visibility, 'Personal');
  assert.equal(rec.domain, 'sales');
  const g = listPersonalKnowledge(amir);
  assert.deepEqual(g.mine.map((e) => e.title), ['How I work']);
});

test('personal entries are owner-private — another user cannot see or read them', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'My notes' });
  // Bea (same domain) does NOT see Amir's Personal entry.
  assert.equal(listPersonalKnowledge(bea).mine.length, 0);
  assert.throws(() => getPersonalKnowledge(rec.id, bea), /Not permitted/);
});

test('the owner can read, edit (title + md), and the edit is versioned', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'Draft', md: 'v1' });
  const updated = updatePersonalKnowledge(rec.id, amir, { title: 'Final', md: 'v2' });
  assert.equal(updated.title, 'Final');
  assert.equal(getPersonalKnowledge(rec.id, amir).md, 'v2');
  // The prior state was snapshotted.
  const versions = listPersonalKnowledgeVersions(rec.id, amir);
  assert.equal(versions.length, 1);
  assert.deepEqual((versions[0].state as { title: string; md: string }), { title: 'Draft', md: 'v1' });
});

test('a no-op edit does not churn a version', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'Same', md: 'body' });
  updatePersonalKnowledge(rec.id, amir, { title: 'Same', md: 'body' });
  assert.equal(listPersonalKnowledgeVersions(rec.id, amir).length, 0);
});

test('archive hides an entry from the working list; unarchive restores it', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'Old note' });
  archivePersonalKnowledge(rec.id, amir);
  assert.equal(listPersonalKnowledge(amir).mine.length, 0);
  assert.equal(listPersonalKnowledge(amir, { includeArchived: true }).mine.length, 1);
  unarchivePersonalKnowledge(rec.id, amir);
  assert.equal(listPersonalKnowledge(amir).mine.length, 1);
});

test('a non-owner in another domain cannot edit or delete', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'Mine' });
  assert.throws(() => updatePersonalKnowledge(rec.id, kenji, { md: 'hack' }), /Not permitted/);
  assert.throws(() => deletePersonalKnowledge(rec.id, kenji), /Not permitted/);
});

test('delete removes the entry and its history', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'Temp' });
  deletePersonalKnowledge(rec.id, amir);
  assert.throws(() => getPersonalKnowledge(rec.id, amir), /not found/);
});

test('archived-delete regression: an ARCHIVED entry deletes for the owner, is denied for a non-owner non-admin, and a missing entry surfaces honestly', () => {
  // Reproduces the reported bug: archive a knowledge note, then Delete it.
  // Server-side the delete must (a) succeed for the owner even once archived,
  // (b) stay fail-closed for a non-owner non-admin, and (c) NOT silently no-op
  // on a missing id — it must throw a 404 the UI can surface.
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'To retire', md: 'body' });
  archivePersonalKnowledge(rec.id, amir);
  // Still present (archived), not yet gone.
  assert.equal(listPersonalKnowledge(amir, { includeArchived: true }).mine.length, 1);
  // A non-owner in another domain (creator/builder — no admin authority) is refused.
  assert.throws(() => deletePersonalKnowledge(rec.id, kenji), /Not permitted/);
  // The owner deletes the archived entry — it is physically gone (record + history).
  deletePersonalKnowledge(rec.id, amir);
  assert.equal(listPersonalKnowledge(amir, { includeArchived: true }).mine.length, 0);
  assert.throws(() => getPersonalKnowledge(rec.id, amir), /not found/);
  // Deleting a now-missing id is an HONEST 404, never a silent success.
  assert.throws(() => deletePersonalKnowledge(rec.id, amir), /not found/);
});

test('restore: reverts to a prior version and snapshots the live state first (reversible)', () => {
  __resetStore();
  const rec = createPersonalKnowledge(amir, { title: 'T', md: 'v1' });
  updatePersonalKnowledge(rec.id, amir, { md: 'v2' }); // snapshots v1 → version #1
  const restored = restorePersonalKnowledgeVersion(rec.id, amir, 1);
  assert.equal(restored.md, 'v1');
  // Two versions now: the original v1 snapshot + the pre-restore v2 snapshot.
  assert.equal(listPersonalKnowledgeVersions(rec.id, amir).length, 2);
});

test('promotion ladder: domain_admin promotes Personal→Shared; a creator and a plain builder cannot', () => {
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Playbook', md: 'x' });
  // A creator (no promote gate) is refused the direct flip.
  assert.throws(() => promotePersonalKnowledge(rec.id, amir), /domain admins and admins/);
  // A plain builder can NO LONGER promote Personal→Shared.
  assert.throws(() => promotePersonalKnowledge(rec.id, bea), /domain admins and admins/);
  const promoted = promotePersonalKnowledge(rec.id, dana);
  assert.equal(promoted.visibility, 'Shared');
  // Now visible to same-domain peers under the domain group.
  assert.equal(listPersonalKnowledge(amir).domain.map((e) => e.title).includes('Playbook'), true);
});

test('certification ladder: only an admin certifies Shared→Marketplace', () => {
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Certifiable', md: 'x' });
  promotePersonalKnowledge(rec.id, dana); // → Shared
  assert.throws(() => certifyPersonalKnowledge(rec.id, bea), /admins can certify/);
  const certified = certifyPersonalKnowledge(rec.id, ada);
  assert.equal(certified.visibility, 'Marketplace');
});

test('promotion guards: cannot re-promote an already-Shared entry, cannot certify a Personal one', () => {
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Guarded', md: 'x' });
  promotePersonalKnowledge(rec.id, dana); // → Shared
  assert.throws(() => promotePersonalKnowledge(rec.id, dana), /already promoted/);
  const rec2 = createPersonalKnowledge(ada, { title: 'Skip', md: 'x' });
  assert.throws(() => certifyPersonalKnowledge(rec2.id, ada), /Promote this knowledge to the domain/);
});

test('DEMOTE: revoke sharing lowers Marketplace → Shared → Personal', () => {
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Roundtrip', md: 'x' });
  promotePersonalKnowledge(rec.id, dana); // → Shared
  certifyPersonalKnowledge(rec.id, ada); // → Marketplace
  // Marketplace → Shared is admin-only (a builder → 403).
  assert.throws(() => decertifyPersonalKnowledge(rec.id, bea), /admins can revoke/);
  assert.equal(decertifyPersonalKnowledge(rec.id, ada).visibility, 'Shared');
  // Shared → Personal: owner, in-domain domain_admin, or admin (fail-closed edit-scope).
  assert.equal(unsharePersonalKnowledge(rec.id, dana).visibility, 'Personal');
});

test('DEMOTE fail-closed: a creator cannot unshare a Shared entry they do not own', () => {
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Team note', md: 'x' });
  promotePersonalKnowledge(rec.id, dana); // → Shared (owned by dana)
  assert.throws(() => unsharePersonalKnowledge(rec.id, amir), /Not permitted/i); // amir = creator, non-owner
  // A plain builder (non-owner) also cannot unshare someone else's shared entry.
  assert.throws(() => unsharePersonalKnowledge(rec.id, bea), /Not permitted/i);
  assert.equal(getPersonalKnowledge(rec.id, amir).visibility, 'Shared');
});

test('Shared-count bug regression: after Personal→Shared promotion the domain group count increments', () => {
  // Regression: the Knowledge tab scope-switcher previously read only
  // domainKnowledge.sections for the Shared count and ignored personal.domain,
  // so a promoted entry never incremented the "(N)" badge.
  __resetStore();
  const rec = createPersonalKnowledge(dana, { title: 'Promoted note', md: 'content' });
  // Before promotion: mine=1, domain=0.
  let g = listPersonalKnowledge(amir); // peer in same domain
  assert.equal(g.domain.length, 0, 'domain count must be 0 before promotion');
  // Promote Personal → Shared.
  promotePersonalKnowledge(rec.id, dana);
  // After promotion: the entry moves from mine to domain, so domain count increments.
  g = listPersonalKnowledge(amir);
  assert.equal(g.domain.length, 1, 'domain count must be 1 after promotion (Shared-count badge fix)');
  assert.equal(g.domain[0].title, 'Promoted note');
  assert.equal(g.domain[0].visibility, 'Shared');
});

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
} from './personal-store.ts';

const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const bea = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const kenji = { id: 'kenji', domains: ['finance'], role: 'builder' as const };

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

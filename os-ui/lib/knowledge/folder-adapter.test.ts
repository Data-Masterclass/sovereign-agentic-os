/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetStore as resetKnowledge, createPersonalKnowledge, type Principal } from './personal-store.ts';
import { knowledgeAdapter } from './folder-adapter.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const user = { id: 'amir', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetKnowledge(); resetFolders(); });

// A personal knowledge entry lives in the PERSONAL lane; the domain lane never sees it
// (same scope-lane discipline as Files/Data — no bug-#1 class here either).
test('a moved personal knowledge entry is found in the PERSONAL scope only', () => {
  const e = createPersonalKnowledge(amir, { title: 'How I work' });
  knowledgeAdapter.moveItem(e.id, user, '/notes');
  assert.deepEqual(
    knowledgeAdapter.itemsUnderFolder(user, 'personal', '/notes').map((i) => i.id),
    [e.id],
  );
  assert.deepEqual(knowledgeAdapter.itemsUnderFolder(user, 'domain', '/notes').map((i) => i.id), []);
});

test('knowledge adapter itemsUnderFolder includes ARCHIVED members for the cascade', () => {
  const e = createPersonalKnowledge(amir, { title: 'Draft' });
  knowledgeAdapter.moveItem(e.id, user, '/keep');
  knowledgeAdapter.archiveItem(e.id, user);
  assert.deepEqual(knowledgeAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [e.id]);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A note saved into a folder makes that folder visible in My knowledge
 * USER STORY: As the owner of an agent run that reported "Saved to My knowledge /results" I want
 *             to find the note under My knowledge → results.
 * ARCHITECTURE:
 *   - Regression: the save did not create the folder ROW the Knowledge rail lists (only a move
 *     did). Every write that files a note into a folder now goes through `fileIntoFolder` →
 *     `ensureFolderRow`; a governed refusal is returned, never swallowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createPersonalKnowledge,
  createPersonalKnowledgeFiled,
  moveKnowledgeFiled,
  promotePersonalKnowledge,
  listPersonalKnowledge,
} from '@tabs/knowledge/lib/personal-store';
import { __resetStore as resetFolders, listFolders } from '@core/folders/index';
import { buildTree } from '@core/kernel/folders';

const nova = { id: 'nova-admin', domains: ['finance'], role: 'admin' as const };
const amir = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const dana = { id: 'dana', domains: ['sales'], role: 'domain_admin' as const };

function reset() {
  __resetStore();
  resetFolders();
}

const knowledgeFolders = (u: typeof amir, scope: 'personal' | 'domain' = 'personal') =>
  listFolders(u, 'knowledge', scope).map((n) => n.path);

test('a note SAVED into a new folder (save_knowledge_note / the agent output saver) makes that folder visible in My knowledge', () => {
  reset();
  // The exact shape the agent output saver produces through save_knowledge_note.
  const rec = createPersonalKnowledge(nova, {
    title: 'Result — 2026-11-23 10:00 UTC',
    md: '## Summary',
    folder: '/results',
    sourceKey: 'agent-output:sys_x:run_y:knowledge:personal:/results:result',
  });
  assert.equal(rec.folder, '/results');
  // The rail lists folder ROWS: the folder is there, in the note's domain.
  const rows = listFolders(nova, 'knowledge', 'personal');
  assert.deepEqual(rows.map((n) => n.path), ['/results']);
  assert.equal(rows[0].domain, 'finance');
  // And the tree the Knowledge tab draws from those rows has a "results" folder holding the note.
  assert.deepEqual(buildTree(rows).map((n) => n.name), ['results']);
  assert.deepEqual(listPersonalKnowledge(nova).mine.map((e) => e.folder), ['/results']);
});

test('nested folders: /knowledge/invoice_rules is a row (its parent is drawn by the tree)', () => {
  reset();
  createPersonalKnowledge(amir, { title: 'Rule', md: 'x', folder: 'knowledge/invoice_rules' });
  assert.deepEqual(knowledgeFolders(amir), ['/knowledge/invoice_rules']);
  const tree = buildTree(listFolders(amir, 'knowledge', 'personal'));
  assert.equal(tree[0].path, '/knowledge');
  assert.equal(tree[0].children[0].path, '/knowledge/invoice_rules');
});

test('a note at the root creates no folder row; the outcome says so', () => {
  reset();
  const { folderRow } = createPersonalKnowledgeFiled(amir, { title: 'Root note', md: 'x' });
  assert.equal(folderRow.state, 'root');
  assert.deepEqual(knowledgeFolders(amir), []);
});

test('saving twice into the same folder keeps ONE row', () => {
  reset();
  createPersonalKnowledge(amir, { title: 'a', md: 'x', folder: '/results' });
  createPersonalKnowledge(amir, { title: 'b', md: 'x', folder: '/results/' });
  assert.deepEqual(knowledgeFolders(amir), ['/results']);
});

test('move: a refused DOMAIN folder row is returned (not swallowed) and the move still stands', () => {
  reset();
  const rec = createPersonalKnowledge(amir, { title: 'Shared note', md: 'x' });
  promotePersonalKnowledge(rec.id, dana); // now Shared → its folders live in the domain tree
  // amir (a creator) owns the note but may not create DOMAIN folder structure.
  const { record, folderRow } = moveKnowledgeFiled(rec.id, amir, '/team');
  assert.equal(record.folder, '/team');
  assert.equal(folderRow.state, 'refused');
  assert.equal(folderRow.state === 'refused' && folderRow.status, 403);
  assert.deepEqual(knowledgeFolders(amir, 'domain'), []);
  // A domain admin's move into the domain tree does create the row.
  const again = moveKnowledgeFiled(rec.id, dana, '/team');
  assert.equal(again.folderRow.state, 'exists');
  assert.deepEqual(knowledgeFolders(dana, 'domain'), ['/team']);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    `save_knowledge_note` — a note in My knowledge, in a folder, saved once per key
 * USER STORY: As a person (or the engine acting as me) I want to keep a result as a note in a
 *             folder of My knowledge, and I want repeating the same save to give me the note I
 *             already have instead of a second copy.
 * ARCHITECTURE:
 *   - The tool is the ONLY governed MCP door that creates a personal-knowledge entry; it calls
 *     the same `createPersonalKnowledge` the Knowledge tab's own route does.
 *   - `sourceKey` is matched against the CALLER'S OWN entries only, so a key never reveals
 *     whether someone else saved something.
 *   - The result says `searchable: false`: a note is not in the retrieval index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { knowledgeWriteTools } from '@tabs/knowledge/mcp/knowledge-write-tools';
import { __resetStore, getPersonalKnowledge, listPersonalKnowledge } from '@tabs/knowledge/lib/personal-store';

const amir: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
const bea: CurrentUser = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };
const tool = knowledgeWriteTools.find((t) => t.name === 'save_knowledge_note')!;
type Saved = { id: string; title: string; folder: string; visibility: string; already?: boolean; searchable: boolean };
const save = (user: CurrentUser, args: Record<string, unknown>) => tool.call(user, args) as Promise<Saved>;

test('a note is saved as the caller, Personal, in the folder asked for', async () => {
  __resetStore();
  const out = await save(amir, { title: 'Run result', md: '## Summary\n12 invoices.', folder: 'results/2026' });
  assert.equal(out.folder, '/results/2026');
  assert.equal(out.visibility, 'Personal');
  assert.equal(out.searchable, false, 'it does not claim to be searchable');
  const rec = getPersonalKnowledge(out.id, amir);
  assert.equal(rec.owner, 'amir');
  assert.equal(rec.md, '## Summary\n12 invoices.');
  assert.deepEqual(listPersonalKnowledge(amir).mine.map((n) => n.id), [out.id]);
  assert.throws(() => getPersonalKnowledge(out.id, bea), /Not permitted/, 'owner-only, like every Personal entry');
});

test('the same sourceKey returns the note already saved — per owner', async () => {
  __resetStore();
  const first = await save(amir, { title: 'Result', md: 'one', folder: '/results', sourceKey: 'agent-output:sys:run:1' });
  const again = await save(amir, { title: 'Result (again)', md: 'two', folder: '/results', sourceKey: 'agent-output:sys:run:1' });
  assert.equal(again.id, first.id);
  assert.equal(again.already, true);
  assert.equal(getPersonalKnowledge(first.id, amir).md, 'one', 'the first save stands; nothing is overwritten');
  assert.equal(listPersonalKnowledge(amir).mine.length, 1);
  // Another person using the same key gets their OWN note, and learns nothing about Amir's.
  const other = await save(bea, { title: 'Result', md: 'bea', sourceKey: 'agent-output:sys:run:1' });
  assert.notEqual(other.id, first.id);
  assert.equal(other.already, undefined);
  // Without a key, every call is a new note.
  await save(amir, { title: 'Result', md: 'three', folder: '/results' });
  assert.equal(listPersonalKnowledge(amir).mine.length, 2);
});

test('a note needs a title and a body', async () => {
  __resetStore();
  await assert.rejects(() => save(amir, { title: ' ', md: 'x' }), /needs a `title`/);
  await assert.rejects(() => save(amir, { title: 'T', md: '  ' }), /non-empty `md`/);
});

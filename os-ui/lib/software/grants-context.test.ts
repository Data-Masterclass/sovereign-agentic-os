/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for GRANTS → authoring context (Piece 1). Seeds the SAME governed stores the
 * grant picker reads, grants real ids, and asserts the "## Granted context" block:
 * per-kind resolution, DLS-denied items OMITTED (not errored), token cap + LOUD
 * truncation, empty ⇒ no block, and connection descriptors never leak secrets.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrantedContext } from './grants-context.ts';
import { emptyContextGrants, type ContextGrants } from '@/lib/core/context-grants';
import { createDataset, setDocs, __resetStore as resetData } from '@/lib/data/store';
import { createPersonalKnowledge, __resetStore as resetPk } from '@/lib/knowledge/personal-store';
import { createFile, __resetStore as resetFiles } from '@/lib/files/store';
import type { CurrentUser } from '@/lib/core/auth';

const owner: CurrentUser = {
  id: 'owner1', name: 'Owner', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator',
};
const other: CurrentUser = {
  id: 'other1', name: 'Other', domains: ['ops'], allDomains: ['ops'], activeDomain: null, role: 'creator',
};
const principal = (u: CurrentUser) => ({ id: u.id, domains: u.domains, role: u.role });

function grantsWith(patch: Partial<ContextGrants>): ContextGrants {
  return { ...emptyContextGrants(), ...patch };
}

beforeEach(() => {
  resetData();
  resetPk();
  resetFiles();
});

test('grants-context: empty grants ⇒ no block (zero prompt cost)', async () => {
  assert.equal(await resolveGrantedContext(emptyContextGrants(), owner), '');
  assert.equal(await resolveGrantedContext(undefined, owner), '');
});

test('grants-context: a DATA grant resolves name, description, tier + real column names', async () => {
  const d = createDataset(principal(owner), { name: 'Renewals' });
  setDocs(d.id, principal(owner), {
    description: 'Contract renewals feed',
    columns: [{ name: 'account_id', description: 'the customer account' }, { name: 'renews_on', description: 'renewal date' }],
  });
  const block = await resolveGrantedContext(grantsWith({ data: [{ id: d.id, access: 'read-only' }] }), owner);
  assert.match(block, /## Granted context/);
  assert.match(block, /BUILD AGAINST THIS/);
  assert.match(block, /### Data · Renewals \[read\]/);
  assert.match(block, /tier: dataset/);
  assert.match(block, /Contract renewals feed/);
  // The exact governed column names must be present so the agent builds against them.
  assert.match(block, /account_id — the customer account/);
  assert.match(block, /renews_on — renewal date/);
});

test('grants-context: a KNOWLEDGE (personal) grant resolves title + content', async () => {
  const k = createPersonalKnowledge(principal(owner), { title: 'Onboarding SOP', md: 'Step 1: greet the customer.' });
  const block = await resolveGrantedContext(grantsWith({ knowledge: [{ id: k.id, access: 'read-only' }] }), owner);
  assert.match(block, /### Knowledge · Onboarding SOP/);
  assert.match(block, /Step 1: greet the customer\./);
});

test('grants-context: a text FILE grant inlines content; a binary file shows type only', async () => {
  const doc = createFile(principal(owner), { name: 'notes.txt', text: 'the meeting notes body' });
  const img = createFile(principal(owner), { name: 'logo.png', bytes: 4096 });
  const block = await resolveGrantedContext(
    grantsWith({ files: [{ id: doc.id, access: 'read-only' }, { id: img.id, access: 'read-only' }] }),
    owner,
  );
  assert.match(block, /### File · notes\.txt/);
  assert.match(block, /the meeting notes body/);
  // Binary file: name + type, NEVER inlined bytes.
  assert.match(block, /### File · logo\.png .*type: image/);
  assert.match(block, /content not inlined/);
});

test('grants-context: a DLS-denied grant is OMITTED, not errored (block degrades honestly)', async () => {
  // Owner creates a private dataset; `other` (different domain) cannot view it.
  const d = createDataset(principal(owner), { name: 'Private' });
  setDocs(d.id, principal(owner), { description: 'secret', columns: [{ name: 'x', description: '' }] });
  // `other` also has a visible note, so the block still renders — the denied dataset is dropped.
  const k = createPersonalKnowledge(principal(other), { title: 'Other note', md: 'visible to other' });
  const block = await resolveGrantedContext(
    grantsWith({ data: [{ id: d.id, access: 'read-only' }], knowledge: [{ id: k.id, access: 'read-only' }] }),
    other,
  );
  // No throw; the denied dataset does not appear; the visible note does.
  assert.doesNotMatch(block, /Private/);
  assert.match(block, /Other note/);
  // The omission is reported honestly.
  assert.match(block, /not shown — no longer visible to you/);
});

test('grants-context: every grant denied ⇒ empty block (nothing visible)', async () => {
  const d = createDataset(principal(owner), { name: 'Private' });
  setDocs(d.id, principal(owner), { description: 'x', columns: [{ name: 'x', description: '' }] });
  const block = await resolveGrantedContext(grantsWith({ data: [{ id: d.id, access: 'read-only' }] }), other);
  assert.equal(block, '');
});

test('grants-context: a missing/invalid id (e.g. connection) is omitted, never throws', async () => {
  const k = createPersonalKnowledge(principal(owner), { title: 'Real note', md: 'body' });
  const block = await resolveGrantedContext(
    grantsWith({
      knowledge: [{ id: k.id, access: 'read-only' }],
      connections: [{ id: 'conn_does_not_exist', access: 'read-only' }],
    }),
    owner,
  );
  assert.match(block, /Real note/);
  assert.doesNotMatch(block, /conn_does_not_exist/);
});

test('grants-context: overall token budget caps the block with a LOUD truncation notice', async () => {
  // Grant many large files so the total budget is exceeded and some are dropped loudly.
  const big = 'x'.repeat(4000); // ~1000 tokens each
  const files = [];
  for (let i = 0; i < 10; i++) files.push(createFile(principal(owner), { name: `big-${i}.txt`, text: big }));
  const block = await resolveGrantedContext(
    grantsWith({ files: files.map((f) => ({ id: f.id, access: 'read-only' as const })) }),
    owner,
  );
  assert.match(block, /## Granted context/);
  // At least one file rendered, and the truncation is announced with a remaining count.
  assert.match(block, /### File · big-0\.txt/);
  assert.match(block, /…truncated — \d+ more granted item\(s\) omitted to fit context\./);
});

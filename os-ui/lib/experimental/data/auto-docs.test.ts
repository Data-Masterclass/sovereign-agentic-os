/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsAutoDocs,
  docsPromptMessages,
  parseDocsDraft,
  mergeEmptyDocs,
  autoDocumentAfterIngest,
  type IngestGrounding,
} from './auto-docs.ts';

const grounding: IngestGrounding = {
  name: 'Orders',
  columns: [{ name: 'order_id', type: 'varchar' }, { name: 'amount', type: 'double' }],
  preview: { columns: ['order_id', 'amount'], rows: [['A1', '9.99'], ['A2', '4.50']] },
};

// ── needsAutoDocs: the trigger predicate ──

test('needsAutoDocs is true only when there is no description AND no column note', () => {
  assert.equal(needsAutoDocs({ description: '', columns: [{ name: 'a', description: '' }] }), true);
  assert.equal(needsAutoDocs({ description: '   ', columns: [] }), true);
  assert.equal(needsAutoDocs({ description: 'has one', columns: [] }), false);
  assert.equal(needsAutoDocs({ description: '', columns: [{ name: 'a', description: 'a note' }] }), false);
});

// ── docsPromptMessages: grounded in the real schema + preview ──

test('the prompt is grounded in the real column names, types and a preview', () => {
  const [system, user] = docsPromptMessages(grounding);
  assert.match(system.content, /ONLY a JSON object/i);
  assert.match(system.content, /never invent/i);
  assert.match(user.content, /order_id \(varchar\)/);
  assert.match(user.content, /amount \(double\)/);
  assert.match(user.content, /A1 \| 9\.99/); // a real preview row is present
});

// ── parseDocsDraft: tolerant parse ──

test('parseDocsDraft parses a clean JSON draft', () => {
  const d = parseDocsDraft('{"description":"Customer orders.","columns":[{"name":"order_id","description":"The order key."}]}');
  assert.deepEqual(d, { description: 'Customer orders.', columns: [{ name: 'order_id', description: 'The order key.' }] });
});

test('parseDocsDraft tolerates a code fence and drops nameless columns', () => {
  const d = parseDocsDraft('```json\n{"description":"X","columns":[{"description":"orphan"},{"name":"amount","description":"€"}]}\n```');
  assert.deepEqual(d, { description: 'X', columns: [{ name: 'amount', description: '€' }] });
});

test('parseDocsDraft returns null on unusable output', () => {
  assert.equal(parseDocsDraft('not json'), null);
  assert.equal(parseDocsDraft('[1,2,3]'), null);
  assert.equal(parseDocsDraft('{"description":"","columns":[]}'), null); // nothing usable
});

// ── mergeEmptyDocs: NEVER overwrite a human's words ──

test('mergeEmptyDocs fills empty description + empty column notes only', () => {
  const merged = mergeEmptyDocs(
    { description: '', columns: [{ name: 'order_id', description: '' }, { name: 'amount', description: '' }] },
    { description: 'Orders.', columns: [{ name: 'order_id', description: 'Key.' }, { name: 'amount', description: 'Money.' }] },
  );
  assert.equal(merged?.description, 'Orders.');
  assert.deepEqual(merged?.columns, [{ name: 'order_id', description: 'Key.' }, { name: 'amount', description: 'Money.' }]);
});

test('mergeEmptyDocs never overwrites a human-written description or note', () => {
  const merged = mergeEmptyDocs(
    { description: 'Human wrote this', columns: [{ name: 'order_id', description: 'human note' }, { name: 'amount', description: '' }] },
    { description: 'AI draft', columns: [{ name: 'order_id', description: 'AI key' }, { name: 'amount', description: 'AI money' }] },
  );
  assert.equal(merged?.description, undefined); // human description preserved (not sent)
  // order_id note preserved; only the empty amount note filled.
  assert.deepEqual(merged?.columns, [{ name: 'order_id', description: 'human note' }, { name: 'amount', description: 'AI money' }]);
});

test('mergeEmptyDocs ignores a draft note for a column the dataset does not have', () => {
  const merged = mergeEmptyDocs(
    { description: '', columns: [{ name: 'order_id', description: '' }] },
    { description: 'Orders.', columns: [{ name: 'ghost', description: 'not a real column' }] },
  );
  assert.equal(merged?.description, 'Orders.');
  assert.equal(merged?.columns, undefined); // no real column note filled
});

test('mergeEmptyDocs returns null when nothing new can be filled', () => {
  const merged = mergeEmptyDocs(
    { description: 'done', columns: [{ name: 'a', description: 'done' }] },
    { description: 'AI', columns: [{ name: 'a', description: 'AI' }] },
  );
  assert.equal(merged, null);
});

// ── autoDocumentAfterIngest: the orchestrator ──

test('autoDocumentAfterIngest drafts + persists on the first empty-docs ingest', async () => {
  let persisted: unknown = null;
  const ok = await autoDocumentAfterIngest(
    { description: '', columns: [{ name: 'order_id', description: '' }] },
    grounding,
    {
      complete: async () => ({ content: '{"description":"Customer orders.","columns":[{"name":"order_id","description":"The order key."}]}' }),
      persist: (docs) => { persisted = docs; },
    },
  );
  assert.equal(ok, true);
  assert.deepEqual(persisted, { description: 'Customer orders.', columns: [{ name: 'order_id', description: 'The order key.' }] });
});

test('autoDocumentAfterIngest does NOTHING when docs already exist (never overwrites)', async () => {
  let called = false;
  const ok = await autoDocumentAfterIngest(
    { description: 'already documented', columns: [] },
    grounding,
    { complete: async () => { called = true; return { content: '{}' }; }, persist: () => { called = true; } },
  );
  assert.equal(ok, false);
  assert.equal(called, false); // the model was never even called
});

test('autoDocumentAfterIngest skips silently when the model is unreachable', async () => {
  let persisted = false;
  const ok = await autoDocumentAfterIngest(
    { description: '', columns: [{ name: 'order_id', description: '' }] },
    grounding,
    {
      complete: async () => { throw Object.assign(new Error('no model configured'), { status: 503 }); },
      persist: () => { persisted = true; },
    },
  );
  assert.equal(ok, false); // no throw, no persist
  assert.equal(persisted, false);
});

test('autoDocumentAfterIngest skips silently on an unusable model reply', async () => {
  let persisted = false;
  const ok = await autoDocumentAfterIngest(
    { description: '', columns: [{ name: 'order_id', description: '' }] },
    grounding,
    { complete: async () => ({ content: 'sorry I cannot help' }), persist: () => { persisted = true; } },
  );
  assert.equal(ok, false);
  assert.equal(persisted, false);
});

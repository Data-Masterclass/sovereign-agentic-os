/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, hashOf, verifyResult, type IngestInput } from '@tabs/files/lib/ingest/types';
import { mockAdapterFor } from '@tabs/files/lib/ingest/mocks';
import { liveAdapterFor } from '@tabs/files/lib/ingest/live';

function input(over: Partial<IngestInput> = {}): IngestInput {
  return { fileId: 'as_1', name: 'x.pdf', kind: 'doc', text: 'First sentence. Second sentence. Third one.', deepLink: 's3://files/amir/x.pdf', ...over };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('chunkText splits into units and hashes each (stable, deterministic)', () => {
  const chunks = chunkText('A. B. C.', 'f');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].hash, hashOf('A.'));
  assert.match(chunks[0].id, /^f#0$/);
});

test('empty text yields no chunks (an empty file indexes nothing)', () => {
  assert.deepEqual(chunkText('   ', 'f'), []);
});

test('mock docling → text representation, chunked + hashed, verifies', async () => {
  const r = await mockAdapterFor('doc').apply(input());
  assert.equal(r.mode, 'mock');
  assert.equal(r.representations[0].type, 'text');
  assert.equal(r.representations[0].chunks.length, 3);
  assert.ok(verifyResult(r));
});

test('mock transcribe → transcript for audio/video', async () => {
  const r = await mockAdapterFor('audio').apply(input({ kind: 'audio', name: 'a.m4a' }));
  assert.equal(r.representations[0].type, 'transcript');
  assert.ok(verifyResult(r));
});

test('mock ocr-caption → caption + ocr for images', async () => {
  const r = await mockAdapterFor('image').apply(input({ kind: 'image', name: 'p.png' }));
  const types = r.representations.map((x) => x.type).sort();
  assert.deepEqual(types, ['caption', 'ocr']);
});

test('mock table → table for spreadsheets', async () => {
  const r = await mockAdapterFor('table').apply(input({ kind: 'table', name: 't.csv' }));
  assert.equal(r.representations[0].type, 'table');
});

test('LIVE docling/table adapters chunk the file’s STORED text and never touch the network', async () => {
  // The Docling call moved to extract.ts (it needs the BYTES, and its text is stored on the file
  // first). What reaches this adapter is that stored text — the upload's own or the parser's.
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('the adapter must not call out'); }) as typeof fetch;
  const doc = await liveAdapterFor('doc').apply(input());
  assert.equal(doc.mode, 'live');
  assert.deepEqual(doc.representations[0].chunks.map((c) => c.text), ['First sentence.', 'Second sentence.', 'Third one.']);
  const table = await liveAdapterFor('table').apply(input({ kind: 'table', name: 't.xlsx', text: '| a | b |\n| 1 | 2 |' }));
  assert.equal(table.representations[0].type, 'table');
  assert.equal(table.representations[0].chunks.length, 2);
  assert.equal(calls, 0);
  assert.ok(verifyResult(doc));
});

test('LIVE docling adapter with NO stored text yields no representation — nothing is invented, nothing indexed', async () => {
  const r = await liveAdapterFor('doc').apply(input({ text: '' }));
  assert.deepEqual(r.representations, []);
  assert.equal(verifyResult(r), false, 'the pipeline reports `empty` and writes no row');
});

test('LIVE transcribe parses ASR segments', async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ segments: [{ text: 'hello there' }, { text: 'second utterance' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await liveAdapterFor('audio').apply(input({ kind: 'audio' }));
  assert.equal(r.mode, 'live');
  assert.equal(r.representations[0].type, 'transcript');
  assert.equal(r.representations[0].chunks[1].text, 'second utterance');
});

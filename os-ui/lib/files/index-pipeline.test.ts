/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexAsset } from './index-pipeline.ts';
import { __resetIndex, hybridQuery, indexSize } from './index-store.ts';
import { mockEmbed } from './embed.ts';
import { mockAdapterFor } from './ingest/mocks.ts';
import { compileDls } from './dls.ts';
import { emptyAsset, type FileAsset } from './asset-schema.ts';

// Inject the deterministic mock embedder so tests are offline + stable.
const embed = async (texts: string[]) => ({ vectors: texts.map((t) => mockEmbed(t)), model: 'sovereign-embed', dim: 384, mode: 'mock' as const });
function opts(kind: FileAsset['kind']) { return { adapter: mockAdapterFor(kind), embed }; }

function asset(over: Partial<FileAsset> = {}): FileAsset {
  return { ...emptyAsset({ id: 'as_1', name: 'doc.pdf', owner: 'amir', domain: 'sales' }), ...over };
}

beforeEach(() => __resetIndex());

test('stored-only files are held but never indexed (opt-out)', async () => {
  const a = asset({ name: 's.pdf' });
  a.indexing.mode = 'stored-only';
  const r = await indexAsset(a, 'secret text here.', opts('doc'));
  assert.equal(r.status, 'stored-only');
  assert.equal(indexSize(), 0);
});

test('a PDF indexes → searchable, chunked + embedded', async () => {
  const a = asset({ name: 'contract.pdf' });
  const r = await indexAsset(a, 'Auto renews after twelve months. Price capped at CPI.', opts('doc'));
  assert.equal(r.status, 'searchable');
  assert.ok(r.indexed >= 2);
  assert.equal(r.embedded, r.indexed);
  assert.deepEqual(r.representations, ['text']);
});

test('an audio file is TRANSCRIBED then indexed (gate)', async () => {
  const a = asset({ id: 'as_aud', name: 'call.m4a', kind: 'audio' });
  const r = await indexAsset(a, 'We agreed a ten percent discount within policy.', opts('audio'));
  assert.equal(r.status, 'searchable');
  assert.deepEqual(r.representations, ['transcript']);
});

test('content-hash cache: re-indexing identical text re-embeds nothing', async () => {
  const a = asset({ name: 'x.pdf' });
  const text = 'Stable sentence one. Stable sentence two.';
  await indexAsset(a, text, opts('doc'));
  const again = await indexAsset(a, text, opts('doc'));
  assert.equal(again.embedded, 0, 'no re-embed for unchanged chunks');
  assert.equal(again.reusedFromCache, again.indexed);
});

test('re-index only embeds the CHANGED chunks', async () => {
  const a = asset({ name: 'x.pdf' });
  await indexAsset(a, 'Keep this one. Old second.', opts('doc'));
  const r = await indexAsset(a, 'Keep this one. New second sentence.', opts('doc'));
  assert.ok(r.embedded >= 1 && r.embedded < r.indexed, 'unchanged chunk reused, changed chunk embedded');
});

test('hybrid query returns the right passage, DLS-scoped', async () => {
  const a = asset({ id: 'as_doc', name: 'renewal.pdf' });
  await indexAsset(a, 'The ACME contract auto renews after twelve months unless cancelled.', opts('doc'));
  const other = asset({ id: 'as_o', name: 'menu.pdf' });
  await indexAsset(other, 'Lunch specials and coffee prices for the week.', opts('doc'));

  const filter = compileDls({ id: 'amir', domains: ['sales'] });
  const hits = hybridQuery({ queryVector: mockEmbed('when does the contract renew'), queryText: 'contract renew', filter });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].fileId, 'as_doc', 'the renewal passage ranks first');
  assert.match(hits[0].text, /renews/);
});

test('hybrid query never returns a chunk the reader may not see (DLS)', async () => {
  const priv = asset({ id: 'as_priv', name: 'private.pdf', owner: 'amir', domain: 'sales' });
  await indexAsset(priv, 'Confidential alpha omega details.', opts('doc'));
  const filter = compileDls({ id: 'kenji', domains: ['finance'] }); // outsider
  const hits = hybridQuery({ queryVector: mockEmbed('alpha omega'), queryText: 'alpha omega', filter });
  assert.equal(hits.length, 0, 'a non-member retrieves nothing');
});

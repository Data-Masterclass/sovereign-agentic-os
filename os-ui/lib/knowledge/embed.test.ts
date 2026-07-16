/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Knowledge `embed.ts` (server) DIM-GUARD tests. The `knowledge` knn_vector field is
 * mapped at `config.embedDim`; the index is embedded AND queried through `embed()`,
 * so a live vector whose length ≠ the index dim would be rejected by OpenSearch at
 * write time and could never match a query vector. The guard: trust a live result
 * ONLY when every row is the configured dim, else fall back to the deterministic
 * offline hash at the correct dim. These tests pin that contract.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embed, embedQuery } from './embed.ts';
import { config } from '../core/config.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('LIVE embeddings are trusted when every row is the configured index dim', async () => {
  const dim = config.embedDim;
  const row = () => Array.from({ length: dim }, (_, i) => (i % 5) / 10);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: row() }, { embedding: row() }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await embed(['a', 'b']);
  assert.equal(r.source, 'litellm');
  assert.equal(r.vectors.length, 2);
  assert.ok(r.vectors.every((v) => v.length === dim));
});

test('SECURITY/CORRECTNESS: a live embedding whose dim ≠ the index falls back to the offline hash', async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await embed(['a', 'b']);
  assert.equal(r.source, 'offline-hash');
  assert.ok(r.vectors.every((v) => v.length === config.embedDim));
});

test('embedQuery falls back to the offline hash (at the index dim) when LiteLLM is down', async () => {
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const r = await embedQuery('anything');
  assert.equal(r.source, 'offline-hash');
  assert.equal(r.vector.length, config.embedDim);
});

test('an empty batch embeds nothing (no network call)', async () => {
  const r = await embed([]);
  assert.deepEqual(r.vectors, []);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockEmbed, embedTexts, embedQuery, cosine } from './embed.ts';
import { config } from '../config.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('mock embedding uses the dim from config (NEVER hardcoded) and is unit-norm', () => {
  const v = mockEmbed('hello world');
  assert.equal(v.length, config.filesEmbedDim);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test('mock embedding is deterministic + gives similar texts a positive cosine', () => {
  assert.deepEqual(mockEmbed('contract renewal'), mockEmbed('contract renewal'));
  assert.ok(cosine(mockEmbed('the contract renews soon'), mockEmbed('when does the contract renew')) > 0);
});

test('LIVE embeddings parse the LiteLLM response (mode: live, dim from the model)', async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await embedTexts(['a', 'b']);
  assert.equal(r.mode, 'live');
  assert.equal(r.dim, 3);
  assert.equal(r.vectors.length, 2);
});

test('embedQuery falls back to the deterministic mock when LiteLLM is down', async () => {
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  const r = await embedQuery('hello');
  assert.equal(r.mode, 'mock');
  assert.equal(r.vector.length, config.filesEmbedDim);
});

test('an empty batch embeds nothing', async () => {
  const r = await embedTexts([]);
  assert.deepEqual(r.vectors, []);
});

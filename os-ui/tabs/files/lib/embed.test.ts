/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockEmbed, embedTexts, embedQuery, cosine } from '@tabs/files/lib/embed';
import { config } from '@core/kernel/config';
import { GatewayRejectedError } from '@core/infra/litellm-credential';

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

test('LIVE embeddings parse the LiteLLM response when the dim matches the index (mode: live)', async () => {
  const dim = config.filesEmbedDim;
  const row = () => Array.from({ length: dim }, (_, i) => (i % 7) / 10);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: row() }, { embedding: row() }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await embedTexts(['a', 'b']);
  assert.equal(r.mode, 'live');
  assert.equal(r.dim, dim);
  assert.equal(r.vectors.length, 2);
});

test('SECURITY/CORRECTNESS: a live embedding whose dim ≠ the index mapping falls back to mock', async () => {
  // The `files` knn_vector field is mapped at config.filesEmbedDim; a wrong-dim
  // live vector would be rejected by OpenSearch (never searchable). Guard: fall
  // back to the deterministic mock at the correct dim instead of indexing junk.
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const r = await embedTexts(['a', 'b']);
  assert.equal(r.mode, 'mock');
  assert.equal(r.dim, config.filesEmbedDim);
  assert.ok(r.vectors.every((v) => v.length === config.filesEmbedDim));
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

// ---------------------------------------------------------------- A3: the fallback rule (A31) --

test('A31: a 4xx THROWS a typed rejection — the Files index never fills with mock vectors', async () => {
  globalThis.fetch = (async () => new Response('key not allowed to access model', { status: 403 })) as typeof fetch;
  await assert.rejects(embedTexts(['a']), (e: unknown) => e instanceof GatewayRejectedError && e.code === 'forbidden');
  globalThis.fetch = (async () => new Response('Budget has been exceeded! Max budget: 5', { status: 400 })) as typeof fetch;
  await assert.rejects(embedQuery('q'), (e: unknown) => e instanceof GatewayRejectedError && e.code === 'budget_exceeded');
});

test('A31: a 5xx or a transport failure falls back to the LABELLED mock at the configured dim', async () => {
  globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
  const r = await embedTexts(['a']);
  assert.equal(r.mode, 'mock');
  assert.equal(r.dim, config.filesEmbedDim);
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  assert.equal((await embedQuery('q')).mode, 'mock');
});

test('A25/A27: the embedding call carries the SCOPED key and the caller tags — never the master key', async () => {
  let seen: { auth: string; body: Record<string, unknown> } | null = null;
  const dim = config.filesEmbedDim;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    seen = { auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: dim }, () => 0.1) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await embedTexts(['a'], { userId: 'rae', domain: 'sales' });
  assert.equal(r.mode, 'live');
  assert.equal(seen!.auth, `Bearer ${config.litellmAgentKey}`);
  assert.notEqual(seen!.auth, `Bearer ${config.litellmMasterKey}`);
  assert.equal(seen!.body.user, 'os-rae');
  assert.deepEqual((seen!.body.metadata as { tags: string[] }).tags, ['domain:sales', 'tab:files']);
});

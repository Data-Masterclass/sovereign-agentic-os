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
import { embed, embedQuery } from '@tabs/knowledge/lib/embed';
import { config } from '@core/kernel/config';
import { GatewayRejectedError } from '@core/infra/litellm-credential';

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

// ---------------------------------------------------------------- A3: the fallback rule (A31) --

test('A31: a 403 (model outside the key allowlist) THROWS a typed rejection — no substitute vectors', async () => {
  globalThis.fetch = (async () => new Response('{"error":{"message":"key not allowed to access model"}}', { status: 403 })) as typeof fetch;
  await assert.rejects(embed(['a']), (e: unknown) => e instanceof GatewayRejectedError && e.code === 'forbidden' && e.status === 403);
});

test('A31: a 400 budget rejection THROWS `budget_exceeded`; a 401 THROWS `unauthorized`', async () => {
  globalThis.fetch = (async () => new Response('Budget has been exceeded! Current cost: 5.2, Max budget: 5', { status: 400 })) as typeof fetch;
  await assert.rejects(embedQuery('q'), (e: unknown) => e instanceof GatewayRejectedError && e.code === 'budget_exceeded');
  globalThis.fetch = (async () => new Response('invalid api key', { status: 401 })) as typeof fetch;
  await assert.rejects(embed(['a']), (e: unknown) => e instanceof GatewayRejectedError && e.code === 'unauthorized');
});

test('A31: a 5xx or a timeout falls back to the LABELLED offline hash at the index dim', async () => {
  globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch;
  const r5 = await embed(['a', 'b']);
  assert.equal(r5.source, 'offline-hash');
  assert.ok(r5.vectors.every((v) => v.length === config.embedDim));
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  // A hung gateway: the 4s guard aborts the request and the labelled fallback answers.
  const ctl = embed(['x']);
  const r = await ctl;
  assert.equal(r.source, 'offline-hash');
});

test('A25/A27: the embedding call carries the SCOPED key, the user and the tags — never the master key', async () => {
  let seen: { auth: string; body: Record<string, unknown> } | null = null;
  const dim = config.embedDim;
  globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    seen = { auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: dim }, () => 0.1) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await embed(['a'], { userId: 'rae', domain: 'sales', tab: 'knowledge' });
  assert.equal(r.source, 'litellm');
  assert.equal(seen!.auth, `Bearer ${config.litellmAgentKey}`);
  assert.notEqual(seen!.auth, `Bearer ${config.litellmMasterKey}`);
  assert.equal(seen!.body.user, 'os-rae');
  assert.deepEqual((seen!.body.metadata as { tags: string[] }).tags, ['domain:sales', 'tab:knowledge']);
  assert.deepEqual(seen!.body.cache, { 'use-cache': true });
});

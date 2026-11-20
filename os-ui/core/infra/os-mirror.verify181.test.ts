/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The independent verifier's fakes for #181: what a whole-index load may accept as complete.
 * USER STORY: As an operator I want a partial OpenSearch answer never to be cached as a store's contents.
 * ARCHITECTURE:
 *   - Copied verbatim from the verifier (worktree verify-181); scriptable fetch fakes, no cluster.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { osMirror } from '@core/infra/os-mirror';

function fake(body: (size: number) => unknown) {
  const orig = globalThis.fetch;
  const sizes: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: 1 });
    const size = Number(new URL('http://x' + path).searchParams.get('size') ?? 10);
    sizes.push(size);
    const b = body(size);
    return typeof b === 'number' ? json({ error: 'x' }, b) : json(b);
  }) as typeof fetch;
  return { sizes, restore: () => { globalThis.fetch = orig; } };
}
const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ _source: { id: `d${i}` } }));

test('V1 partial shards: failed=0 but successful < total must not be "loaded"', async () => {
  const f = fake(() => ({ timed_out: false, _shards: { total: 2, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 3, relation: 'eq' }, hits: docs(3) } }));
  const m = osMirror({ index: 'v181-partial-shards' }); m.__reset();
  try { assert.equal(await m.hydrate(), null); } finally { f.restore(); }
});

test('V2 timed_out:true → null', async () => {
  const f = fake(() => ({ timed_out: true, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 1, relation: 'eq' }, hits: docs(1) } }));
  const m = osMirror({ index: 'v181-timed-out' }); m.__reset();
  try { assert.equal(await m.hydrate(), null); } finally { f.restore(); }
});

test('V3 hits.total (1500) > hits returned (1000, the store size) must not be "loaded" as 1000', async () => {
  const f = fake((size) => ({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 1500, relation: 'eq' }, hits: docs(Math.min(size, 1500)) } }));
  const m = osMirror({ index: 'v181-total-gt-hits' }); m.__reset();
  try {
    const out = await m.hydrate(1000);
    assert.ok(out === null || out.length === 1500, `got ${out?.length} of 1500 accepted as loaded`);
  } finally { f.restore(); }
});

test('V4 hits.total relation gte (track_total_hits ignored) must not be "loaded"', async () => {
  const f = fake(() => ({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 10000, relation: 'gte' }, hits: docs(1000) } }));
  const m = osMirror({ index: 'v181-gte' }); m.__reset();
  try { const out = await m.hydrate(1000); assert.ok(out === null || out.length > 10000, `got ${out?.length}`); } finally { f.restore(); }
});

test('V5 hydrate never sends a default size (10) and never > max_result_window', async () => {
  const f = fake((size) => size > 10000 ? 400 : ({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 1, relation: 'eq' }, hits: docs(1) } }));
  const m = osMirror({ index: 'v181-size' }); m.__reset();
  try { await m.hydrate(); assert.ok(f.sizes.every((s) => s > 10 && s <= 10000), String(f.sizes)); } finally { f.restore(); }
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { osMirror } from './os-mirror.ts';

/**
 * Tests for the shared durable-mirror core — the regression suite for the
 * bootstrap bug (fresh cluster → `_count` 404 → mirror marked dead forever →
 * index never created → every deploy wiped all state since the last roll).
 */

type Call = { method: string; path: string; body?: string };

/** Scriptable fake of the OpenSearch REST surface. `indexExists` starts false
 *  (a FRESH cluster); `down` simulates an unreachable cluster. */
function fakeOs(state: { indexExists?: boolean; down?: boolean } = {}) {
  const calls: Call[] = [];
  const s = { indexExists: state.indexExists ?? false, down: state.down ?? false };
  const docs = new Map<string, unknown>();
  const orig = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? String(init.body) : undefined });
    if (s.down) throw new Error('ECONNREFUSED');
    if (path.endsWith('/_count')) {
      return s.indexExists ? json({ count: docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    }
    if (path.includes('/_search')) {
      if (!s.indexExists) return json({ error: 'index_not_found_exception' }, 404);
      return json({ hits: { hits: [...docs.values()].map((_source) => ({ _source })) } });
    }
    if (path.includes('/_doc/')) {
      const id = path.split('/_doc/')[1].split('?')[0];
      if (method === 'DELETE') { docs.delete(id); return json({ result: 'deleted' }); }
      if (method === 'GET') {
        return docs.has(id) ? json({ _id: id, _source: docs.get(id) }) : json({ found: false }, 404);
      }
      if (!s.indexExists) return json({ error: 'index_not_found_exception' }, 404); // no auto-create in this fake
      docs.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    // PUT /<index> → create the index.
    if (method === 'PUT') {
      if (s.indexExists) return json({ error: 'resource_already_exists_exception' }, 400);
      s.indexExists = true;
      return json({ acknowledged: true });
    }
    return json({});
  }) as typeof fetch;
  return { calls, docs, state: s, restore: () => { globalThis.fetch = orig; } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('fresh cluster: _count 404 → index is CREATED, mirror healthy, hydrate returns []', async () => {
  const os = fakeOs({ indexExists: false });
  const m = osMirror({ index: 'os-mirror-test-a', createBody: { mappings: { properties: { id: { type: 'keyword' } } } } });
  m.__reset();
  try {
    const docs = await m.hydrate();
    assert.deepEqual(docs, [], 'a missing index hydrates to empty, NOT to "mirror down"');
    assert.equal(m.healthy(), true, 'the mirror is healthy after bootstrap');
    const create = os.calls.find((c) => c.method === 'PUT' && c.path === '/os-mirror-test-a');
    assert.ok(create, 'the index was created');
    assert.equal(create!.body, JSON.stringify({ mappings: { properties: { id: { type: 'keyword' } } } }), 'with the store-provided body, verbatim');
  } finally {
    os.restore();
  }
});

test('the regression: writeThrough after a fresh-cluster boot actually PUTs the doc (count-404 → index-create → doc-PUT)', async () => {
  const os = fakeOs({ indexExists: false });
  const m = osMirror({ index: 'os-mirror-test-b' });
  m.__reset();
  try {
    await m.hydrate(); // boot-time hydration on the fresh cluster
    m.writeThrough('doc1', { id: 'doc1', v: 42 });
    await settle();
    const seq = os.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    assert.deepEqual(seq, [
      'GET /os-mirror-test-b/_count',
      'PUT /os-mirror-test-b',
      'POST /os-mirror-test-b/_search',
      'PUT /os-mirror-test-b/_doc/doc1',
    ]);
    assert.deepEqual(os.docs.get('doc1'), { id: 'doc1', v: 42 }, 'the first artifact PERSISTED — the chicken-and-egg is gone');
  } finally {
    os.restore();
  }
});

test('cluster down: probe/hydrate/writeThrough never throw; hydrate → null (offline mode)', async () => {
  const os = fakeOs({ down: true });
  const m = osMirror({ index: 'os-mirror-test-c' });
  m.__reset();
  try {
    assert.equal(await m.probe(), false);
    assert.equal(await m.hydrate(), null, 'unreachable cluster → null (distinct from empty index)');
    m.writeThrough('doc1', { id: 'doc1' }); // must not throw
    m.deleteThrough('doc1'); // must not throw
    await settle();
    assert.equal(m.healthy(), false);
  } finally {
    os.restore();
  }
});

test('self-heal: OpenSearch down at boot, up later → a write re-probes, bootstraps the index and persists THAT doc', async () => {
  const os = fakeOs({ down: true });
  const m = osMirror({ index: 'os-mirror-test-d', reprobeMs: 0 }); // no throttle for the test
  m.__reset();
  try {
    assert.equal(await m.hydrate(), null, 'boot while the cluster is down');
    os.state.down = false; // the cluster comes up (index still missing)
    m.writeThrough('healed', { id: 'healed' });
    await settle();
    await settle(); // probe → create → send is two async hops
    assert.equal(m.healthy(), true, 'the lazy re-probe healed the mirror');
    assert.deepEqual(os.docs.get('healed'), { id: 'healed' }, 'the triggering write persisted after heal');
    // Subsequent writes go straight through.
    m.writeThrough('next', { id: 'next' });
    await settle();
    assert.deepEqual(os.docs.get('next'), { id: 'next' });
  } finally {
    os.restore();
  }
});

test('re-probe is throttled: while unhealthy inside the window, writes are dropped without hitting the network', async () => {
  const os = fakeOs({ down: true });
  const m = osMirror({ index: 'os-mirror-test-e', reprobeMs: 60_000 });
  m.__reset();
  try {
    await m.probe(); // probed + unhealthy, lastProbeAt = now
    const before = os.calls.length;
    m.writeThrough('a', { id: 'a' });
    m.writeThrough('b', { id: 'b' });
    await settle();
    assert.equal(os.calls.length, before, 'no network traffic inside the throttle window');
  } finally {
    os.restore();
  }
});

test('concurrent probes dedupe into one _count request', async () => {
  const os = fakeOs({ indexExists: true });
  const m = osMirror({ index: 'os-mirror-test-f' });
  m.__reset();
  try {
    await Promise.all([m.probe(), m.probe(), m.probe()]);
    assert.equal(os.calls.filter((c) => c.path.endsWith('/_count')).length, 1);
  } finally {
    os.restore();
  }
});

test('index-create race: a concurrent creator winning (400 already-exists) still counts as healthy', async () => {
  const os = fakeOs({ indexExists: false });
  const m = osMirror({ index: 'os-mirror-test-g' });
  m.__reset();
  try {
    os.state.indexExists = true; // someone else created it between our _count and PUT
    // _count still 404s in this scripted order? Simulate directly: _count 404 then PUT → 400.
    os.state.indexExists = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (path.endsWith('/_count')) return new Response('{}', { status: 404 });
      if ((init?.method ?? 'GET') === 'PUT') return new Response('{"error":"resource_already_exists_exception"}', { status: 400 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      assert.equal(await m.probe(), true);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    os.restore();
  }
});

test('getDoc returns the _source when present and null when missing', async () => {
  const os = fakeOs({ indexExists: true });
  const m = osMirror({ index: 'os-mirror-test-h' });
  m.__reset();
  try {
    await m.probe();
    m.writeThrough('one', { id: 'one', x: 1 });
    await settle();
    assert.deepEqual(await m.getDoc('one'), { id: 'one', x: 1 });
    assert.equal(await m.getDoc('absent'), null);
  } finally {
    os.restore();
  }
});

test('hydration round-trip: a doc written through comes back unchanged after a "restart"', async () => {
  const os = fakeOs({ indexExists: false });
  const m = osMirror({ index: 'os-mirror-test-i' });
  m.__reset();
  try {
    await m.hydrate();
    const doc = { id: 'rt', nested: { yaml: 'a: 1\n', arr: [1, 2, 3] }, updatedAt: '2026-01-01T00:00:00.000Z' };
    m.writeThrough('rt', doc);
    await settle();
    m.__reset(); // simulate a fresh process
    const docs = await m.hydrate();
    assert.deepEqual(docs, [doc], 'byte-identical round-trip through the mirror');
  } finally {
    os.restore();
  }
});

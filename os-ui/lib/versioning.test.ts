/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Unit tests for the reusable version-history helper (lib/versioning.ts):
 * append/list/get/latest ordering, deep-clone isolation, purge, and a durable
 * round-trip through a scriptable fake of the OpenSearch REST surface (a doc
 * persisted through the mirror hydrates back unchanged after a pod roll).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionLog } from './versioning.ts';

// ---------------------------------------------------------------- fake cluster --
// Minimal single-purpose fake of the OpenSearch REST surface, FRESH by default
// (no indices — the state right after a clean install with an empty PVC).
function fakeCluster() {
  const indices = new Map<string, Map<string, unknown>>();
  const orig = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = url.match(/^https?:\/\/opensearch:9200(\/.*)$/);
    if (!m) return json({});
    const [, indexName, rest] = m[1].match(/^\/([^/?]+)(.*)$/) ?? [];
    const idx = indices.get(indexName);
    if (rest?.startsWith('/_count')) return idx ? json({ count: idx.size }) : json({}, 404);
    if (rest?.startsWith('/_search')) {
      if (!idx) return json({}, 404);
      return json({ hits: { hits: [...idx.values()].map((_source) => ({ _source })) } });
    }
    if (rest?.startsWith('/_doc/')) {
      const id = decodeURIComponent(rest.slice('/_doc/'.length).split('?')[0]);
      if (method === 'DELETE') { idx?.delete(id); return json({ result: 'deleted' }); }
      if (!idx) return json({}, 404);
      idx.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    if (method === 'PUT' && (rest === '' || rest.startsWith('?'))) {
      if (idx) return json({}, 400);
      indices.set(indexName, new Map());
      return json({ acknowledged: true });
    }
    return json({});
  }) as typeof fetch;
  return {
    indexSize: (index: string) => indices.get(index)?.size ?? 0,
    restore: () => { globalThis.fetch = orig; },
  };
}

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

test('record: assigns monotonic 1-based versions and lists newest-first', () => {
  const log = versionLog('test-basic');
  log.__reset();
  const v1 = log.record('a1', 'alice', { yaml: 'v1' }, 'edit');
  const v2 = log.record('a1', 'bob', { yaml: 'v2' }, 'edit');
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(log.latest('a1'), 2);
  const list = log.list('a1');
  assert.deepEqual(list.map((v) => v.version), [2, 1]); // newest first
  assert.equal(list[0].author, 'bob');
  // isolated per artifact
  assert.equal(log.latest('a2'), 0);
  assert.deepEqual(log.list('a2'), []);
  log.__reset();
});

test('record: deep-clones state so later mutation cannot rewrite history', () => {
  const log = versionLog('test-clone');
  log.__reset();
  const live = { yaml: 'original', nested: { a: 1 } };
  log.record('x', 'alice', live);
  live.yaml = 'mutated';
  live.nested.a = 99;
  const snap = log.get('x', 1)!.state as { yaml: string; nested: { a: number } };
  assert.equal(snap.yaml, 'original');
  assert.equal(snap.nested.a, 1);
  log.__reset();
});

test('get + summary default; purge forgets an artifact', () => {
  const log = versionLog('test-purge');
  log.__reset();
  log.record('p', 'alice', { n: 1 }); // no summary → defaults to 'edit'
  assert.equal(log.get('p', 1)!.summary, 'edit');
  assert.equal(log.get('p', 2), undefined);
  log.record('p', 'alice', { n: 2 }, 'restore of v1');
  assert.equal(log.get('p', 2)!.summary, 'restore of v1');
  log.purge('p');
  assert.deepEqual(log.list('p'), []);
  assert.equal(log.latest('p'), 0);
  log.__reset();
});

test('durability: versions persist through a mocked mirror and hydrate back after a pod roll', async () => {
  const os = fakeCluster();
  const log = versionLog('test-durable');
  try {
    log.__reset();
    await log.ensureHydrated();
    log.record('d1', 'alice', { yaml: 'first' }, 'edit');
    log.record('d1', 'bob', { yaml: 'second' }, 'edit');
    await settle();
    // Both snapshots landed in the durable mirror (index auto-bootstrapped).
    assert.equal(os.indexSize('os-versions-test-durable'), 2);

    // Pod roll: in-process history gone, cluster kept → hydrates back unchanged.
    log.__reset();
    await log.ensureHydrated();
    const list = log.list('d1');
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((v) => v.version), [2, 1]);
    assert.equal((list[0].state as { yaml: string }).yaml, 'second');
    assert.equal(list[1].author, 'alice');
  } finally {
    log.__reset();
    os.restore();
  }
});

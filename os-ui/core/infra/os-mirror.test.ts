/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { osMirror, PATCH_SCRIPT } from '@core/infra/os-mirror';

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

test('getDoc RETRIES a transient 5xx and never surfaces a false not-found', async () => {
  // Reproduces the intermittent "commit → App not found": a momentary OpenSearch
  // hiccup on a by-id GET must NOT be reported as "not found".
  const orig = globalThis.fetch;
  let getCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path.includes('/_doc/')) {
      getCalls++;
      if (getCalls < 3) return new Response('unavailable', { status: 503 }); // hiccup twice
      return new Response(JSON.stringify({ _id: 'app1', _source: { id: 'app1', ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const m = osMirror({ index: 'os-mirror-test-retry' });
    assert.deepEqual(await m.getDoc('app1'), { id: 'app1', ok: true });
    assert.equal(getCalls, 3, 'retried the transient error until it succeeded');
  } finally {
    globalThis.fetch = orig;
  }
});

test('getDoc returns null IMMEDIATELY on a genuine 404 (no wasted retries)', async () => {
  const orig = globalThis.fetch;
  let getCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path.includes('/_doc/')) {
      getCalls++;
      return new Response(JSON.stringify({ found: false }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const m = osMirror({ index: 'os-mirror-test-404' });
    assert.equal(await m.getDoc('nope'), null);
    assert.equal(getCalls, 1, 'a real 404 is authoritative — no retries');
  } finally {
    globalThis.fetch = orig;
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

test('patchThrough sends a partial scripted _update: only the named fields, upsert only when given', async () => {
  const os = fakeOs({ indexExists: true });
  const m = osMirror({ index: 'os-mirror-test-patch' });
  m.__reset();
  try {
    await m.probe();
    m.patchThrough('p1', { set: { lastRun: { ok: true } }, unset: ['activity'] });
    m.patchThrough('p2', { set: { name: 'n' }, unset: [] }, { upsert: { id: 'p2', name: 'n' } });
    await settle();
    const updates = os.calls.filter((c) => c.path.includes('/_update/'));
    assert.equal(updates.length, 2);
    assert.equal(updates[0].method, 'POST');
    assert.match(updates[0].path, /^\/os-mirror-test-patch\/_update\/p1\?refresh=true&retry_on_conflict=3$/);
    const first = JSON.parse(updates[0].body!);
    assert.equal(first.script.lang, 'painless');
    assert.equal(first.script.source, PATCH_SCRIPT);
    assert.deepEqual(first.script.params, { set: { lastRun: { ok: true } }, unset: ['activity'] });
    assert.equal('upsert' in first, false, 'no upsert: a partial write never creates a doc');
    assert.deepEqual(JSON.parse(updates[1].body!).upsert, { id: 'p2', name: 'n' });
    assert.equal(os.calls.some((c) => c.method === 'PUT' && c.path.includes('/_doc/')), false, 'never a whole-doc PUT');
  } finally {
    os.restore();
  }
});

// --- Phase-0 regression gate: silent mirror write loss (review finding 2) ------

test('MIRROR-DURABILITY: a 503 on PUT must surface — not leave healthy=true with the write lost', { todo: 'fixed in Phase 2' }, async () => {
  const m = osMirror({ index: 'os-gate-test' });
  m.__reset();
  const orig = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    log.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`);
    if (url.includes('/_count')) return new Response(JSON.stringify({ count: 0 }), { status: 200 });
    if (method === 'PUT' && url.includes('/_doc/')) return new Response('{"error":"unavailable"}', { status: 503 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await m.probe(), true, 'probe succeeds → mirror believed healthy');
    m.writeThrough('doc-1', { hello: 'world' });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(log.some((l) => l.startsWith('PUT /os-gate-test/_doc/doc-1')), 'the PUT was attempted');
  // The defect: after a failed PUT the mirror still reports healthy and nothing is queued/reported.
  assert.equal(m.healthy(), false, 'a failed write must flip health (or be queued + reported) — never silently succeed');
});

// --- The DELETE counterpart of the gate above: a confirmed delete surfaces a failure ---------

/** A fake whose `_doc` DELETE answers with the scripted statuses in order (then the last one). */
function scriptedDelete(statuses: (number | 'down')[]) {
  const orig = globalThis.fetch;
  const deletes: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    if (url.includes('/_count')) return new Response(JSON.stringify({ count: 1 }), { status: 200 });
    if (method === 'DELETE' && url.includes('/_doc/')) {
      deletes.push(url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]);
      const st = statuses[Math.min(i++, statuses.length - 1)];
      if (st === 'down') throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ result: st === 404 ? 'not_found' : 'deleted' }), { status: st });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { deletes, restore: () => { globalThis.fetch = orig; } };
}

test('MIRROR-DURABILITY (delete): a 503 on DELETE surfaces as a failed delete after a bounded retry', async () => {
  const m = osMirror({ index: 'os-gate-del' });
  m.__reset();
  const os = scriptedDelete([503]);
  try {
    const out = await m.deleteConfirmed('doc-1', { attempts: 3, backoffMs: 1 });
    assert.equal(out.ok, false, 'a delete the store refused is never reported as done');
    assert.match((out as { reason: string }).reason, /503/);
    assert.equal(os.deletes.length, 3, 'bounded: exactly three attempts');
  } finally {
    os.restore();
  }
});

test('deleteConfirmed: a transient failure then success is a confirmed delete', async () => {
  const m = osMirror({ index: 'os-gate-del2' });
  m.__reset();
  const os = scriptedDelete(['down', 503, 200]);
  try {
    assert.deepEqual(await m.deleteConfirmed('doc-1', { attempts: 3, backoffMs: 1 }), { ok: true, result: 'deleted' });
    assert.equal(os.deletes.length, 3);
  } finally {
    os.restore();
  }
});

test('deleteConfirmed: 404 means already gone — confirmed, no retry', async () => {
  const m = osMirror({ index: 'os-gate-del3' });
  m.__reset();
  const os = scriptedDelete([404]);
  try {
    assert.deepEqual(await m.deleteConfirmed('doc-1', { backoffMs: 1 }), { ok: true, result: 'absent' });
    assert.equal(os.deletes.length, 1);
  } finally {
    os.restore();
  }
});

test('deleteConfirmed: an unreachable cluster is a failed delete, never a silent success', async () => {
  const m = osMirror({ index: 'os-gate-del4' });
  m.__reset();
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    const out = await m.deleteConfirmed('doc-1', { backoffMs: 1 });
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, /unreachable/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('an index larger than one page is PAGED to completion; one that cannot be read whole is not loaded, and is logged', async () => {
  const { hydrationShortfalls } = await import('@core/infra/os-mirror');
  const orig = globalThis.fetch;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  let total = 2500;
  let serveAtMost = Infinity; // a server that stops returning hits early (a partial read)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: total });
    const size = Number(/size=(\d+)/.exec(path)?.[1] ?? 10);
    const from = Number(/from=(\d+)/.exec(path)?.[1] ?? 0);
    const n = Math.max(0, Math.min(size, total - from, serveAtMost - from));
    return json({ hits: { total: { value: total, relation: 'eq' }, hits: Array.from({ length: n }, (_, i) => ({ _source: { id: `d${from + i}` } })) } });
  }) as typeof fetch;
  const m = osMirror({ index: 'os-mirror-test-shortfall', createBody: {} });
  m.__reset();
  try {
    const all = await m.hydrate(2000);
    assert.equal(all?.length, 2500, 'two pages, every record');
    assert.equal(new Set((all as { id: string }[]).map((d) => d.id)).size, 2500, 'no page repeated');

    serveAtMost = 2000; // the second page comes back short
    assert.equal(await m.hydrate(2000), null, 'a short read is NOT the store contents');
    const s = hydrationShortfalls().find((x) => x.index === 'os-mirror-test-shortfall');
    assert.deepEqual(s && { loaded: s.loaded, total: s.total }, { loaded: 2000, total: 2500 });
    assert.ok(errors.some((e) => /hydration NOT complete \(loaded 2000 of 2500\)/.test(e)), 'logged loudly');

    serveAtMost = Infinity;
    total = 1500;
    assert.equal((await m.hydrate(2000))?.length, 1500);
    assert.equal(hydrationShortfalls().find((x) => x.index === 'os-mirror-test-shortfall'), undefined, 'a full load clears it');
  } finally {
    globalThis.fetch = orig;
    console.error = origError;
  }
});

test('a FAILED hydration search (503 while shards initialise) is "not readable yet" (null), never an empty index', async () => {
  const orig = globalThis.fetch;
  let searchStatus = 503;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: 2 });
    if (path.includes('/_search')) {
      if (searchStatus !== 200) return json({ error: 'search_phase_execution_exception' }, searchStatus);
      return json({ _shards: { failed: 0 }, hits: { total: { value: 1 }, hits: [{ _source: { id: 'a' } }] } });
    }
    return json({});
  }) as typeof fetch;
  const m = osMirror({ index: 'os-mirror-test-503', createBody: {} });
  m.__reset();
  try {
    assert.equal(await m.hydrate(), null, '503 → null, so the store retries instead of caching zero records');
    searchStatus = 200;
    assert.deepEqual(await m.hydrate(), [{ id: 'a' }], 'once readable, the real records load');
  } finally {
    globalThis.fetch = orig;
  }
});

test('a hydration search with failed shards is incomplete → null', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: 5 });
    return json({ _shards: { failed: 1 }, hits: { total: { value: 0 }, hits: [] } });
  }) as typeof fetch;
  const m = osMirror({ index: 'os-mirror-test-shards', createBody: {} });
  m.__reset();
  try {
    assert.equal(await m.hydrate(), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('regression 0.9.21: a whole-index hydration slower than 2.5 s (live os-datasets: 132 records, ~0.7 MB) loads every record', async () => {
  // Shaped like the live index on 2026-11-20: 99 + 10 archived `dataset`, 19 + 4 archived `asset`.
  const shape: [string, boolean, number][] = [['dataset', false, 99], ['dataset', true, 10], ['asset', false, 19], ['asset', true, 4]];
  const live = shape.flatMap(([tier, archived, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `ds-${tier}-${archived ? 'a' : 'l'}-${i}`, archived, yaml: `tier: ${tier}\nname: x${i}\n${'# pad\n'.repeat(800)}` })));
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: live.length });
    // The search answers after 3 s — slower than the old 2.5 s cap — and honours abort.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    return json({ _shards: { failed: 0 }, hits: { total: { value: live.length }, hits: live.map((_source) => ({ _source })) } });
  }) as typeof fetch;
  const m = osMirror({ index: 'os-mirror-test-slow', createBody: {} });
  m.__reset();
  try {
    const docs = await m.hydrate();
    assert.equal(docs?.length, 132, 'every record of the live-shaped index is loaded, none dropped');
    assert.equal((docs as { yaml: string }[]).filter((d) => d.yaml.startsWith('tier: asset')).length, 23);
  } finally {
    globalThis.fetch = orig;
  }
});

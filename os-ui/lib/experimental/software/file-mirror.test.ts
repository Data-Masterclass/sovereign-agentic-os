/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';
import {
  snapshotFiles,
  getSnapshot,
  hydrateSnapshot,
  deleteSnapshot,
  __resetSnapshots,
} from './file-mirror.ts';

/**
 * The durable app-source mirror (ARCHITECTURE #243): every committed tree is
 * write-through to `os-app-files` so a pod restart no longer loses the source
 * (the northpeak-products loss — two built stories gone with a vanished repo).
 * These tests fake the OpenSearch REST surface the shared os-mirror core drives.
 */

type Call = { method: string; path: string; body?: string };

/** Scriptable fake of the OpenSearch REST surface used by os-mirror. `down`
 *  simulates an unreachable cluster; the index bootstraps on the first _count 404. */
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
      return s.indexExists ? json({ count: docs.size }) : json({ error: 'index_not_found' }, 404);
    }
    if (path.includes('/_search')) {
      if (!s.indexExists) return json({ error: 'index_not_found' }, 404);
      return json({ hits: { hits: [...docs.values()].map((_source) => ({ _source })) } });
    }
    if (path.includes('/_doc/')) {
      const id = decodeURIComponent(path.split('/_doc/')[1].split('?')[0]);
      if (method === 'DELETE') {
        const had = docs.delete(id);
        return json({ result: had ? 'deleted' : 'not_found' }, had ? 200 : 404);
      }
      if (method === 'GET') {
        return docs.has(id) ? json({ _id: id, _source: docs.get(id) }) : json({ found: false }, 404);
      }
      docs.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    if (method === 'PUT') {
      // PUT /<index> — create the index (no /_doc/ in path handled above).
      if (s.indexExists) return json({ error: 'resource_already_exists' }, 400);
      s.indexExists = true;
      return json({ acknowledged: true });
    }
    return json({});
  }) as typeof fetch;
  return { calls, docs, state: s, restore: () => { globalThis.fetch = orig; } };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const tree = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.tsx`, content: `// file ${i}\n` }));

test('write-through: snapshotFiles persists the WHOLE tree durably (one doc per app)', async () => {
  const os = fakeOs({ indexExists: false });
  __resetSnapshots();
  try {
    await hydrateSnapshot('app_x'); // boot-time probe on the fresh cluster
    snapshotFiles('app_x', tree(3));
    await settle();
    const doc = os.docs.get('app_x') as { appId: string; files: unknown[] } | undefined;
    assert.ok(doc, 'a durable doc exists for the app');
    assert.equal(doc!.appId, 'app_x');
    assert.equal(doc!.files.length, 3, 'the full tree is mirrored, not just names');
    // In-process read is unchanged (synchronous).
    assert.equal(getSnapshot('app_x')!.length, 3);
  } finally {
    os.restore();
    __resetSnapshots();
  }
});

test('restart-survivability: a FRESH process hydrates the tree from the mirror', async () => {
  const os = fakeOs({ indexExists: false });
  __resetSnapshots();
  try {
    await hydrateSnapshot('app_r');
    snapshotFiles('app_r', tree(4));
    await settle();

    // Simulate a pod restart: the in-process Map is wiped, but the mirror survives.
    // (os-mirror probe state is reset too, exactly like a new process bootstrapping.)
    const persisted = os.docs; // keep the durable docs across the "restart"
    __resetSnapshots();
    assert.equal(getSnapshot('app_r'), null, 'cold process has nothing in memory');
    assert.equal(persisted.size, 1, 'but the durable mirror still holds the tree');

    const hydrated = await hydrateSnapshot('app_r');
    assert.ok(hydrated, 'the tree is recovered from the mirror after restart');
    assert.equal(hydrated!.length, 4);
    // And the synchronous read now works for downstream callers.
    assert.equal(getSnapshot('app_r')!.length, 4, 'hydrate populated the Map');
  } finally {
    os.restore();
    __resetSnapshots();
  }
});

test('hydrate is a Map-hit no-op when the tree is already in-process (no wasted fetch)', async () => {
  const os = fakeOs({ indexExists: true });
  __resetSnapshots();
  try {
    snapshotFiles('app_h', tree(2));
    await settle();
    os.calls.length = 0; // forget the write-through calls
    const files = await hydrateSnapshot('app_h');
    assert.equal(files!.length, 2);
    assert.equal(os.calls.length, 0, 'a Map-hit does NOT touch OpenSearch');
  } finally {
    os.restore();
    __resetSnapshots();
  }
});

test('mirror down: snapshotFiles still works in-memory and never throws; hydrate → null', async () => {
  const os = fakeOs({ down: true });
  __resetSnapshots();
  try {
    snapshotFiles('app_d', tree(2)); // must not throw
    assert.equal(getSnapshot('app_d')!.length, 2, 'in-process store stays authoritative');
    // A DIFFERENT (cold) app id has nothing in memory and the mirror is unreachable.
    assert.equal(await hydrateSnapshot('app_cold'), null, 'down mirror → null, honest degrade');
  } finally {
    os.restore();
    __resetSnapshots();
  }
});

test('deleteSnapshot removes the durable doc (app delete)', async () => {
  const os = fakeOs({ indexExists: true });
  __resetSnapshots();
  try {
    snapshotFiles('app_del', tree(1));
    await settle();
    assert.ok(os.docs.has('app_del'));
    deleteSnapshot('app_del');
    await settle();
    assert.equal(os.docs.has('app_del'), false, 'the durable source doc is gone after delete');
  } finally {
    os.restore();
    __resetSnapshots();
  }
});

test('the app-files mirror uses its OWN index, distinct from the app-record index', () => {
  assert.notEqual(config.appFilesIndex, config.appsIndex, 'source files live in a separate index from the record');
});

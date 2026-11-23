/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test fixture — two os-ui processes sharing one OpenSearch
 * USER STORY: As a maintainer I want to prove, with the real store code, that a write made in
 *             one process (the `os-ui-worker` running an agent) never overwrites a newer edit
 *             made in the other (`os-ui`, the web app) — and that the edit survives a restart.
 * ARCHITECTURE:
 *   - TEST-ONLY (imported by `*.test.ts` files; nothing in the app imports it).
 *   - `fakeCluster()` replaces `fetch` with an in-memory OpenSearch that implements exactly the
 *     REST calls `os-mirror.ts` makes: `_count`, `_search`, `_doc` GET/PUT/DELETE, index create,
 *     and `_update` with the mirror's patch script (`params.set` / `params.unset`; `upsert` only
 *     when sent; a missing doc without `upsert` answers 404, like OpenSearch).
 *   - A "process" is the set of `globalThis` slots a store pins its state to (the same slots
 *     separately bundled route handlers share in production). `as(p, fn)` swaps them in, marks
 *     the run-worker process when `p.worker`, runs `fn`, swaps them out and lets the mirror's
 *     fire-and-forget writes land. A restart is a process with empty slots.
 *   - Generalised from `tabs/agents/lib/store-two-process.test.ts` (PR #114).
 */
import { opensearchBaseUrl } from '@core/adapters/opensearch/client';
import { markRunWorkerProcess, __clearRunWorkerProcess } from '@core/kernel/process-role';

type Doc = Record<string, unknown>;

export type FakeCluster = {
  /** The stored `_source` of one doc, or undefined. */
  doc(index: string, id: string): Doc | undefined;
  /** Every request the fake answered, oldest first (`METHOD /index/...`). */
  calls: string[];
  /** Every `_search`, by kind: a whole-index listing or a changes read (`range` on `updatedAt`). */
  searches: { index: string; kind: 'whole' | 'changes' }[];
  /** Replace one stored doc as another process (or a late write) would. */
  put(index: string, id: string, doc: Doc): void;
  /** Remove one stored doc, as a delete made in another process leaves it. */
  remove(index: string, id: string): void;
  /** How `_search` answers: 'ok'; 'error' (500); 'truncated' (one hit fewer than the total it reports);
   *  'down' (every request fails, as an unreachable cluster). */
  mode: 'ok' | 'error' | 'truncated' | 'down';
  restore(): void;
};

export function fakeCluster(): FakeCluster {
  const indices = new Map<string, Map<string, Doc>>();
  const calls: string[] = [];
  const searches: { index: string; kind: 'whole' | 'changes' }[] = [];
  const ctl ={ mode: 'ok' as FakeCluster['mode'] };
  const orig = globalThis.fetch;
  const base = opensearchBaseUrl();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) return json({});
    const method = init?.method ?? 'GET';
    const path = url.slice(base.length).split('?')[0];
    calls.push(`${method} ${path}`);
    if (ctl.mode === 'down') return json({ error: 'unavailable' }, 503);
    const [, index, rest = ''] = path.match(/^\/([^/]+)(.*)$/) ?? [];
    const docs = indices.get(index);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (rest === '/_count') return docs ? json({ count: docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    if (rest === '/_search') {
      if (!docs) return json({}, 404);
      if (ctl.mode === 'error') return json({ error: 'search_phase_execution_exception' }, 500);
      // A changes read (`osMirror.changedSince`): `range.updatedAt.gte`, compared as ISO strings.
      const gte = body?.query?.range?.updatedAt?.gte as string | undefined;
      searches.push({ index, kind: gte === undefined ? 'whole' : 'changes' });
      const all = [...docs.values()]
        .filter((d) => gte === undefined || String(d.updatedAt ?? '') >= gte)
        .map((_source) => ({ _source }));
      // 'truncated': one hit short of the total the index reports (as a cut-off page answers).
      const hits = ctl.mode === 'truncated' ? all.slice(0, Math.max(0, all.length - 1)) : all;
      const total = ctl.mode === 'truncated' ? hits.length + 1 : all.length;
      return json({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: total, relation: 'eq' }, hits } });
    }
    if (rest === '/_settings' || rest === '/_mapping') return json({ acknowledged: true });
    if (rest === '' && method === 'PUT') {
      if (docs) return json({ error: 'resource_already_exists_exception' }, 400);
      indices.set(index, new Map());
      return json({ acknowledged: true });
    }
    if (!docs) return json({ error: 'index_not_found_exception' }, 404);
    const docId = decodeURIComponent(rest.replace(/^\/_(doc|update|create)\//, ''));
    // `PUT <index>/_create/<id>`: create-only — 409 when the doc exists, never an overwrite.
    if (rest.startsWith('/_create/')) {
      if (docs.has(docId)) return json({ error: 'version_conflict_engine_exception' }, 409);
      docs.set(docId, body);
      return json({ result: 'created' }, 201);
    }
    if (rest.startsWith('/_doc/')) {
      if (method === 'GET') return docs.has(docId) ? json({ _source: docs.get(docId) }) : json({ found: false }, 404);
      if (method === 'DELETE') return docs.delete(docId) ? json({ result: 'deleted' }) : json({ result: 'not_found' }, 404);
      docs.set(docId, body);
      return json({ result: 'updated' });
    }
    if (rest.startsWith('/_update/')) {
      const cur = docs.get(docId);
      if (!cur) {
        if (!body?.upsert) return json({ error: 'document_missing_exception' }, 404);
        docs.set(docId, body.upsert);
        return json({ result: 'created' });
      }
      const params = body?.script?.params ?? {};
      const next: Doc = { ...cur, ...(params.set ?? {}) };
      for (const k of (params.unset ?? []) as string[]) delete next[k];
      docs.set(docId, next);
      return json({ result: 'updated' });
    }
    return json({});
  }) as typeof fetch;
  return {
    doc: (index, id) => indices.get(index)?.get(id),
    calls,
    searches,
    put: (index, id, doc) => {
      if (!indices.has(index)) indices.set(index, new Map());
      indices.get(index)!.set(id, doc);
    },
    remove: (index, id) => {
      indices.get(index)?.delete(id);
    },
    get mode() {
      return ctl.mode;
    },
    set mode(m) {
      ctl.mode = m;
    },
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/** Let the mirror's fire-and-forget fetches (and any awaited merge before them) land. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

/** One simulated process: its own copy of each named `globalThis` slot. */
export type Proc = { slots: Map<symbol, unknown>; worker: boolean };

export function proc(worker = false): Proc {
  return { slots: new Map(), worker };
}

/**
 * Run `fn` as process `p`. `keys` are the `Symbol.for(...)` slots the stores under test pin their
 * state to; each is swapped to `p`'s copy (absent → fresh, like a process that just booted).
 */
export async function as<T>(p: Proc, keys: readonly symbol[], fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  for (const k of keys) {
    if (p.slots.has(k)) g[k] = p.slots.get(k);
    else delete g[k];
  }
  if (p.worker) markRunWorkerProcess();
  else __clearRunWorkerProcess();
  try {
    const out = await fn();
    await settle();
    return out;
  } finally {
    for (const k of keys) p.slots.set(k, g[k]);
    __clearRunWorkerProcess();
  }
}

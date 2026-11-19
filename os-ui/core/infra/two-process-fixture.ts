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
import { config } from '@core/kernel/config';
import { markRunWorkerProcess, __clearRunWorkerProcess } from '@core/kernel/process-role';

type Doc = Record<string, unknown>;

export type FakeCluster = {
  /** The stored `_source` of one doc, or undefined. */
  doc(index: string, id: string): Doc | undefined;
  /** Every request the fake answered, oldest first (`METHOD /index/...`). */
  calls: string[];
  restore(): void;
};

export function fakeCluster(): FakeCluster {
  const indices = new Map<string, Map<string, Doc>>();
  const calls: string[] = [];
  const orig = globalThis.fetch;
  const base = config.opensearchUrl.replace(/\/$/, '');
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) return json({});
    const method = init?.method ?? 'GET';
    const path = url.slice(base.length).split('?')[0];
    calls.push(`${method} ${path}`);
    const [, index, rest = ''] = path.match(/^\/([^/]+)(.*)$/) ?? [];
    const docs = indices.get(index);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (rest === '/_count') return docs ? json({ count: docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    if (rest === '/_search') {
      if (!docs) return json({}, 404);
      const hits = [...docs.values()].map((_source) => ({ _source }));
      return json({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: hits.length, relation: 'eq' }, hits } });
    }
    if (rest === '/_settings' || rest === '/_mapping') return json({ acknowledged: true });
    if (rest === '' && method === 'PUT') {
      if (docs) return json({ error: 'resource_already_exists_exception' }, 400);
      indices.set(index, new Map());
      return json({ acknowledged: true });
    }
    if (!docs) return json({ error: 'index_not_found_exception' }, 404);
    const docId = decodeURIComponent(rest.replace(/^\/_(doc|update)\//, ''));
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

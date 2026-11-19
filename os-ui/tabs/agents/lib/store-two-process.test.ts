/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A run in the worker never overwrites a definition edited in the web app
 * USER STORY: As a builder I edit my agent system while one of its runs is executing in the
 *             worker pod. When the run finishes and os-ui later restarts, my edit is still there —
 *             and the run's own report and in-flight checkpoint are still there too.
 * ARCHITECTURE:
 *   - Two simulated PROCESSES share one fake OpenSearch: `os-ui` (A) and `os-ui-worker` (B). Each
 *     process's registry is the `globalThis`-pinned store state, swapped in and out around every
 *     step; B additionally carries the run-worker marker. A restart of A is a fresh, empty state
 *     that hydrates from the mirror — exactly what an os-ui pod does at boot (it reads OpenSearch,
 *     not git).
 *   - The fake implements the REST calls the mirror makes: `_count`, `_search`, `_doc` GET/PUT/
 *     DELETE, index create, and `_update` with the mirror's patch script (`params.set` /
 *     `params.unset`, `upsert` only when sent; a missing doc without `upsert` is a 404).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import * as store from '@tabs/agents/lib/store';
import type { LastRun, Principal } from '@tabs/agents/lib/store';
import { markRunWorkerProcess, __clearRunWorkerProcess } from '@tabs/agents/lib/write-availability';

// ---------------------------------------------------------------- fake cluster --

function fakeCluster() {
  const indices = new Map<string, Map<string, Record<string, unknown>>>();
  const orig = globalThis.fetch;
  const base = config.opensearchUrl.replace(/\/$/, '');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(base)) return json({});
    const method = init?.method ?? 'GET';
    const path = url.slice(base.length).split('?')[0];
    const [, index, rest = ''] = path.match(/^\/([^/]+)(.*)$/) ?? [];
    const docs = indices.get(index);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (rest === '/_count') return docs ? json({ count: docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    if (rest === '/_search') return docs ? json({ hits: { hits: [...docs.values()].map((_source) => ({ _source })) } }) : json({}, 404);
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
      const next = { ...cur, ...(params.set ?? {}) };
      for (const k of (params.unset ?? []) as string[]) delete next[k];
      docs.set(docId, next);
      return json({ result: 'updated' });
    }
    return json({});
  }) as typeof fetch;
  return {
    doc: (id: string) => indices.get('os-agent-systems')?.get(id),
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/** Let the mirror's fire-and-forget fetches land. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

// ------------------------------------------------------------- two processes --

const STATE_KEY = Symbol.for('soa.agents.store');
type Proc = { state: unknown; worker: boolean };
const g = globalThis as unknown as Record<symbol, unknown>;

/** Run `fn` as process `p`: its own registry in memory, its own worker marker. */
async function as<T>(p: Proc, fn: () => T | Promise<T>): Promise<T> {
  g[STATE_KEY] = p.state;
  if (p.worker) markRunWorkerProcess();
  else __clearRunWorkerProcess();
  try {
    return await fn();
  } finally {
    p.state = g[STATE_KEY];
    __clearRunWorkerProcess();
    await settle();
  }
}

const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };

const EDITED = 'Answer in French, always.';

function lastRunOf(runId: string): LastRun {
  return { at: Date.now(), running: false, ok: true, path: ['assistant'], traces: 0, held: 0, steps: [], output: 'done', runId, mode: 'live' };
}

/** os-ui creates a system; the worker picks the run up (refresh from the mirror, start markers). */
async function startScenario() {
  const os = fakeCluster();
  store.__resetStore();
  const web: Proc = { state: undefined, worker: false };
  const worker: Proc = { state: undefined, worker: true };
  const id = await as(web, async () => {
    await store.ensureHydrated();
    return store.createSystem(bea, { name: 'Support desk' }).id;
  });
  await as(worker, async () => {
    await store.ensureHydrated();
    assert.equal(await store.refreshSystemFromMirror(id), 'refreshed');
    // One module serves both simulated processes, so the worker pod's own nonce is set explicitly.
    store.setActivity(id, { kind: 'running', startedAt: Date.now(), instanceId: 'proc_worker_pod' });
    store.startRunCheckpoint(id, { prompt: 'help', plannedNodes: ['assistant'], runId: 'run_1', checkpointer: 'postgres' });
    store.checkpointNode(id, { phase: 'start', node: 'assistant' });
  });
  return { os, web, worker, id };
}

/** os-ui edits AGENT.md of the system's first agent (a definition change). */
async function editInWeb(web: Proc, id: string) {
  await as(web, () => {
    const agent = store.getSystem(id, bea).system.agents[0].id;
    const f = store.readFile(id, bea, `agents/${agent}/AGENT.md`);
    store.writeFile(id, bea, { path: f.path, content: EDITED, sha: f.sha });
  });
}

/** os-ui restarts: an empty registry that hydrates from the mirror. */
async function restartWeb(): Promise<Proc> {
  const fresh: Proc = { state: undefined, worker: false };
  await as(fresh, () => store.ensureHydrated());
  return fresh;
}

const agentMdOf = (p: Proc, id: string) =>
  as(p, () => {
    const view = store.getSystem(id, bea);
    return view.system.agents[0].agent_md ?? '';
  });

test('an edit made in os-ui while the worker runs the system survives the run and an os-ui restart', async () => {
  const { os, web, worker, id } = await startScenario();
  try {
    await editInWeb(web, id);
    assert.equal(await agentMdOf(web, id), EDITED, 'os-ui holds the edit');

    // The run finishes in the worker: its node completes, its report is stored, its markers clear.
    await as(worker, () => {
      store.checkpointNode(id, { phase: 'complete', node: 'assistant', status: 'ok', finalText: 'done' });
      store.setLastRun(id, bea, lastRunOf('run_1'));
      store.clearActivity(id);
    });

    const rebooted = await restartWeb();
    assert.equal(await agentMdOf(rebooted, id), EDITED, 'the edit must survive the worker finishing the run');
    const back = await as(rebooted, () => store.getSystem(id, bea));
    assert.equal(back.lastRun?.runId, 'run_1', "the worker's run report is kept too");
    assert.equal(back.activity, undefined, 'the cleared in-flight marker stays cleared');
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test("an edit made in os-ui during a run does not erase the worker's in-flight checkpoint", async () => {
  const { os, web, worker, id } = await startScenario();
  try {
    await as(worker, () => store.checkpointNode(id, { phase: 'complete', node: 'assistant', status: 'ok', finalText: 'half way' }));
    await editInWeb(web, id);

    // The worker dies here (no clearActivity). The next os-ui boot must still see the run and
    // recover it as interrupted, with the completed step — and keep the edit.
    const mirrored = os.doc(id) as { runCheckpoint?: { completedNodes?: unknown[] }; activity?: unknown } | undefined;
    assert.ok(mirrored?.activity, 'the in-flight marker is still in the mirror after the edit');
    assert.equal(mirrored?.runCheckpoint?.completedNodes?.length, 1, 'the checkpoint is still in the mirror after the edit');
    const rebooted = await restartWeb();
    const back = await as(rebooted, () => store.getSystem(id, bea));
    assert.equal(back.lastRun?.interrupted, true, 'the abandoned run is recovered as interrupted');
    assert.deepEqual(back.lastRun?.path, ['assistant']);
    assert.equal(await agentMdOf(rebooted, id), EDITED);
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('a system deleted in os-ui while the worker runs it is not brought back by the run finishing', async () => {
  const { os, web, worker, id } = await startScenario();
  try {
    await as(web, () => store.deleteSystem(id, bea));
    assert.equal(os.doc(id), undefined, 'the delete reached the mirror');

    await as(worker, () => {
      store.checkpointNode(id, { phase: 'complete', node: 'assistant', status: 'ok' });
      store.setLastRun(id, bea, lastRunOf('run_1'));
      store.clearActivity(id);
    });

    assert.equal(os.doc(id), undefined, 'the run bookkeeping must not recreate the deleted system');
    const rebooted = await restartWeb();
    assert.equal(await as(rebooted, () => store.__recordFor(id)), undefined);
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('the worker writes only run fields: never yaml, name, grants or the last build', async () => {
  const { os, web, worker, id } = await startScenario();
  try {
    // A rename in os-ui (a definition field outside the yaml) during the run…
    await as(web, () => store.renameAgentSystem(id, bea, 'Support desk v2'));
    await as(worker, () => {
      store.recordActivity(id);
      store.setLastRun(id, bea, lastRunOf('run_1'));
      store.clearActivity(id);
    });
    const doc = os.doc(id) as { name?: string; lastActivity?: string | null; lastRun?: { runId?: string } };
    assert.equal(doc.name, 'Support desk v2', 'the name os-ui wrote is the name in the mirror');
    assert.equal(doc.lastRun?.runId, 'run_1');
    assert.ok(doc.lastActivity, 'the activity stamp the worker wrote is kept');
  } finally {
    os.restore();
    store.__resetStore();
  }
});

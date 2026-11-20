/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53c — the id preflight reads the store's durable mirror with ZERO writes
 * USER STORY: As the operator I want to run the preflight against production at any time and know
 *             it changes nothing: no run marked interrupted, no index created or reconfigured.
 * ARCHITECTURE:
 *   - A scripted fake of the OpenSearch REST surface (`globalThis.fetch`, the pattern of
 *     `core/infra/os-mirror.test.ts`) records every request. The mirror holds a system whose run is
 *     marked `running` by a process that no longer exists — exactly the record the registry's
 *     hydration would "recover" (mark interrupted) and write back.
 *   - Twin: the registry hydration path (`ensureHydrated`) on the same mirror DOES write; the
 *     preflight's read-only load does not.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '@tabs/agents/lib/store';
import { main } from '@tabs/agents/lib/module/preflight-run';

const LEGACY = `version: '1'
system: { name: Legacy, domain: sales, visibility: Shared }
entrypoint: Lead Analyst
state: { channels: { messages: add_messages } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: Lead Analyst, role: r, agent_md: '# lead', memory_md: '' }
edges: []
`;
const DOCS = [
  { id: 'sys_legacy1', name: 'Legacy', domain: 'sales', owner: 'amir', visibility: 'Shared', yaml: LEGACY, updatedAt: '2026-11-01T00:00:00.000Z',
    // An in-flight run owned by a process that is gone: hydration's crash recovery rewrites this.
    activity: { kind: 'running', startedAt: 1, instanceId: 'proc_dead' }, runCheckpoint: { runId: 'run_1', startedAt: 1, updatedAt: 1, plannedNodes: ['a'], completedNodes: [] } },
];

type Call = { method: string; path: string };
let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

function fakeMirror(): Call[] {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (path.endsWith('/_count')) return json({ count: DOCS.length });
    if (path.includes('/_search')) return json({ _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: DOCS.length, relation: 'eq' }, hits: DOCS.map((_source) => ({ _source: structuredClone(_source) })) } });
    return json({ result: 'updated', _id: 'x' });
  }) as typeof fetch;
  restore = () => { globalThis.fetch = orig; };
  return calls;
}

const READS = (c: Call) => (c.method === 'GET' && c.path.endsWith('/_count')) || (c.method === 'POST' && /\/_search(\?|$)/.test(c.path));

test('the preflight reads the store mirror with _count/_search only — zero writes — and still finds the refused system', async () => {
  const calls = fakeMirror();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  let code: number;
  try {
    code = await main(['--json']);
  } finally {
    console.log = log;
  }
  assert.equal(code, 1, lines.join('\n'));
  const report = JSON.parse(lines.join('\n')) as { findings: { source: string; where: string }[] };
  assert.deepEqual(report.findings.map((f) => `${f.source} ${f.where}`), ['store sales:sys_legacy1']);
  assert.ok(calls.length > 0, 'the mirror was read');
  const writes = calls.filter((c) => !READS(c));
  assert.deepEqual(writes, [], 'no write of any kind reached the mirror');
});

test('twin: the registry hydration path on the same mirror DOES write (it recovers the dead run) — which is why the preflight does not use it', async () => {
  const calls = fakeMirror();
  store.__resetStore();
  await store.ensureHydrated();
  // The recovery write goes out asynchronously (write-through); give it one turn of the loop.
  await new Promise((r) => setTimeout(r, 200));
  const writes = calls.filter((c) => !READS(c));
  assert.ok(writes.some((c) => c.path.includes('sys_legacy1')), `expected the hydration path to write the recovered record back; requests: ${JSON.stringify(calls)}`);
  store.__resetStore();
});

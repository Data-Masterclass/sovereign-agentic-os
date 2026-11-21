/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Agents panel asks every upstream for the viewer's systems only, and an upstream
 *             that is down is reported, never shown as zero; Platform is admin-only.
 * USER STORY: As a creator I must never see another user's agent system in Monitoring — not its
 *             latency, not its spend, not its policy denials — and as anyone I must be told when a
 *             number is missing rather than shown a 0.
 * ARCHITECTURE:
 *   - The upstream readers are replaced by recorders (`mock.module`); their real-component proofs
 *     are the *.int.test.ts files. What is tested here is the glue: which ids each read is given,
 *     that a foreign row returned anyway is dropped, and the `unavailable` path.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A configured run store; the pool is never queried (runStats is the recorder below).
process.env.AGENT_RUNS_DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';

/** The real module's exports, so a partial replacement keeps everything else other importers need. */
const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });

const asked: Record<string, unknown> = {};
let langfuseDown = false;
let scopeLevel: 'user' | 'builder' | 'admin' = 'user';

mock.module('@tabs/monitoring/lib/scope', {
  namedExports: {
    ...(await real('@tabs/monitoring/lib/scope')), scopeForUser: async (u: { id: string; domains: string[] }) => ({ level: scopeLevel, principal: u.id, domains: u.domains, cluster: scopeLevel === 'admin', via: 'identity' }) },
});
mock.module('@tabs/agents/lib/store', {
  namedExports: {
    ...(await real('@tabs/agents/lib/store')),
    ensureHydrated: async () => {},
    agentHealthRows: (p: { id: string }) => (p.id === 'ada' ? [{ id: 'sysA', name: 'A', scope: 'mine', agentCount: 1, running: false, scheduled: false, lastRunAt: null, lastRunOk: null, held: 0, health: 'grey' }] : []),
  },
});
mock.module('@tabs/monitoring/lib/adapters/run-stats', {
  namedExports: {
    ...(await real('@tabs/monitoring/lib/adapters/run-stats')),
    runStats: async (_sql: unknown, q: { systemIds: string[]; visibleTo?: unknown }) => {
      asked.runStats = q;
      return new Map([['sysA', { systemId: 'sysA', days: [{ day: '2026-11-21', done: 2, failed: 1, held: 0, active: 0, other: 0 }], failureClasses: { budget_exceeded: 1, other: 0 }, lastFailures: [{ runId: 'run_1', at: '2026-11-21T10:00:00Z', requestedBy: 'ada', node: 'w', reason: 'x' }] }]]);
    },
  },
});
mock.module('@core/adapters/langfuse/metrics', {
  namedExports: {
    ...(await real('@core/adapters/langfuse/metrics')),
    systemTraceStats: async (ids: string[]) => {
      asked.langfuse = ids;
      if (langfuseDown) return { ok: false, reason: 'unreachable', detail: 'connect ECONNREFUSED', at: '' };
      return { ok: true, at: '', value: new Map([['sysA', { systemId: 'sysA', traces: 3, p50Ms: 900, p95Ms: 2000, tokens: 300, costUsd: 0.01 }]]) };
    },
  },
});
mock.module('@core/adapters/victoria-logs/query', {
  namedExports: {
    ...(await real('@core/adapters/victoria-logs/query')),
    logsQuery: async (q: string) => {
      asked.logsql = q;
      // A foreign principal answered anyway must still be dropped.
      return { ok: true, at: '', value: [{ 'input.principal': 'os-sysA', 'input.tool': 'crm_write', 'result.effect': 'deny', n: '2' }, { 'input.principal': 'os-sysZ', 'input.tool': 'x', 'result.effect': 'deny', n: '9' }] };
    },
  },
});
mock.module('@core/infra/litellm-admin', { namedExports: { ...(await real('@core/infra/litellm-admin')), readAllKeys: async () => ({ ok: true, data: [{ key_alias: 'os-sysA', spend: 1.25 }, { key_alias: 'os-sysZ', spend: 50 }] }) } });
mock.module('@core/infra/langfuse', { namedExports: { ...(await real('@core/infra/langfuse')), traceUrlFor: async (id: string) => `https://lf.example/trace/${id}` } });
mock.module('@core/policy/approvals', {
  namedExports: {
    ...(await real('@core/policy/approvals')),
    ensureHydrated: async () => {},
    listApprovals: () => [
      { id: 'ap1', systemId: 'sysA', title: 'Write CRM', tool: 'crm_write', createdAt: '2026-11-21T09:00:00Z', status: 'pending' },
      { id: 'ap2', systemId: 'sysZ', title: 'Other', tool: 'x', createdAt: '2026-11-21T09:00:00Z', status: 'pending' },
    ],
  },
});

const { agentsView } = await import('./agents-panel');
const { platformView, PlatformForbiddenError } = await import('./platform-panel');

const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;

beforeEach(() => {
  for (const k of Object.keys(asked)) delete asked[k];
  langfuseDown = false;
  scopeLevel = 'user';
});

test('every upstream read is narrowed to the viewer’s systems; foreign rows are dropped', async () => {
  const v = await agentsView(ada, Date.parse('2026-11-21T12:00:00Z'));
  assert.deepEqual(asked.langfuse, ['sysA']);
  assert.deepEqual((asked.runStats as { systemIds: string[] }).systemIds, ['sysA']);
  assert.deepEqual((asked.runStats as { visibleTo: unknown }).visibleTo, { requestedBy: 'ada', domains: [] });
  assert.match(String(asked.logsql), /\^os-\(sysA\)\(:\|\$\)/);
  assert.deepEqual(v.systems.map((s) => s.id), ['sysA']);
  const a = v.systems[0];
  assert.equal(a.keySpendUsd, 1.25);
  assert.equal(a.policy!.denies, 2);
  assert.deepEqual(a.approvalsWaiting.map((x) => x.id), ['ap1']);
  assert.equal(a.runs!.lastFailures[0].traceUrl, 'https://lf.example/trace/run_1');
  assert.ok(!JSON.stringify(v).includes('sysZ'), 'nothing about sysZ reaches the payload');
});

test('a down upstream is unavailable with its reason, and its fields are absent — never zero', async () => {
  langfuseDown = true;
  const v = await agentsView(ada);
  assert.equal(v.sources.langfuse.state, 'unavailable');
  assert.match((v.sources.langfuse as { reason: string }).reason, /ECONNREFUSED/);
  assert.equal('traces' in v.systems[0], false);
  assert.equal(v.sources.runStore.state, 'live');
});

test('Platform refuses a non-admin before reading anything', async () => {
  await assert.rejects(platformView(ada), (e) => e instanceof PlatformForbiddenError && (e as { status: number }).status === 403);
});

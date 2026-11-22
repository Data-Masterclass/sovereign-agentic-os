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
      { id: 'ap1', systemId: 'sysA', title: 'Write CRM', tool: 'crm_write', createdAt: '2026-11-21T09:00:00Z', status: 'pending', requestedBy: 'ada', domain: 'sales' },
      { id: 'ap2', systemId: 'sysZ', title: 'Other', tool: 'x', createdAt: '2026-11-21T09:00:00Z', status: 'pending', requestedBy: 'ada', domain: 'sales' },
      // On the SAME (shared) system: another creator's request in ada's domain, and one from another domain.
      { id: 'ap-bob', systemId: 'sysA', title: 'Write CRM to customer jane@acme.example', tool: 'crm_write', createdAt: '2026-11-21T09:00:00Z', status: 'pending', requestedBy: 'bob', domain: 'sales' },
      { id: 'ap-hr', systemId: 'sysA', title: 'HR export', tool: 'hr_write', createdAt: '2026-11-21T09:00:00Z', status: 'pending', requestedBy: 'carl', domain: 'hr' },
    ],
  },
});

const { registerMonitoringSources } = await import('./sources');
// The Agents store's scoped list, as monitoring-sources.ts hands it over: ada sees sysA only.
registerMonitoringSources({
  agentSystems: async (p) => (p.id === 'ada' || p.id === 'ben' ? [{ id: 'sysA', name: 'A', scope: 'mine' }] : []),
  datasets: async () => [],
  latestTests: async () => new Map(),
  syncSchedules: async () => [],
  connectionCatalogs: async () => [],
  assetKeys: async () => new Map(),
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
  assert.deepEqual(a.approvalsWaiting!.map((x) => x.id), ['ap1']);
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

const ben = { id: 'ben', name: 'Ben', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' } as never;

test('approvals waiting follow the governance rule canSee — a creator sees only their own request', async () => {
  const v = await agentsView(ada);
  assert.deepEqual(v.systems[0].approvalsWaiting!.map((x) => x.id), ['ap1']);
  // Negative twin: bob's request on the same shared system — title and all — never reaches ada.
  assert.ok(!JSON.stringify(v).includes('jane@acme.example'));
  assert.ok(!JSON.stringify(v).includes('ap-hr'));
});

test('approvals waiting: a builder sees their own domain\'s requests, never another domain\'s', async () => {
  scopeLevel = 'builder';
  const v = await agentsView(ben);
  assert.deepEqual(v.systems[0].approvalsWaiting!.map((x) => x.id).sort(), ['ap-bob', 'ap1']);
  assert.ok(!JSON.stringify(v).includes('HR export'), 'the hr request must not reach a sales builder');
});

test('the MCP door get_monitoring_panels applies the same approval rule', async () => {
  const { MONITORING_TOOLS } = await import('@core/mcp/monitoring-tools');
  const tool = MONITORING_TOOLS.find((t) => t.name === 'get_monitoring_panels')!;
  const v = (await tool.call(ada, { view: 'agents' })) as Awaited<ReturnType<typeof agentsView>>;
  assert.deepEqual(v.systems[0].approvalsWaiting!.map((x) => x.id), ['ap1']);
  assert.ok(!JSON.stringify(v).includes('jane@acme.example'));
});

// --------------------------------------------------------------------------- key drift ---

const { setKeyReconcile } = await import('@core/infra/agent-key-drift');
const driftReport = (over: Record<string, unknown> = {}) => ({
  at: Date.parse('2026-11-21T11:55:00Z'), ok: true, scanned: 2, inSync: 0, notBuilt: 0, inFlight: 0, unchecked: [],
  entries: [
    { systemId: 'sysA', alias: 'os-sysA', kind: 'drift', changes: ['budget $500 → $5'], firstSeenAt: Date.parse('2026-11-21T11:00:00Z'), action: 'alert' },
    { systemId: 'sysZ', alias: 'os-sysZ', kind: 'missing', changes: ['the gateway no longer holds this system\'s key'], firstSeenAt: 1, action: 'alert' },
  ],
  ...over,
}) as never;

test('KEY DRIFT: the viewer gets the drift of their own system and nothing about any other', async () => {
  setKeyReconcile(driftReport());
  const v = await agentsView(ada);
  assert.deepEqual(v.systems[0].keyDrift, { kind: 'drift', changes: ['budget $500 → $5'], since: '2026-11-21T11:00:00.000Z', action: 'alert' });
  assert.equal(v.sources.keyReconcile.state, 'live');
  assert.ok(!JSON.stringify(v).includes('sysZ'), 'the other system\'s drift does not reach the payload');
  assert.ok(!JSON.stringify(v).includes('os-sysZ'));
});

test('KEY DRIFT negative twins: no pass yet, or a pass that could not look, is "unavailable" — never "no drift"', async () => {
  setKeyReconcile(driftReport({ ok: false, entries: [], error: 'registry not hydrated' }));
  const v = await agentsView(ada);
  assert.equal(v.sources.keyReconcile.state, 'unavailable');
  assert.equal('keyDrift' in v.systems[0], false, 'a field the source could not give is absent, not null');
  (globalThis as unknown as { __osKeyReconcile?: unknown }).__osKeyReconcile = undefined;
  const none = await agentsView(ada);
  assert.equal(none.sources.keyReconcile.state, 'unavailable');
  assert.match((none.sources.keyReconcile as { reason: string }).reason, /not run/);
});

test('KEY DRIFT: a system that is in sync carries no keyDrift (null), distinct from "unknown"', async () => {
  setKeyReconcile(driftReport({ entries: [] }));
  const v = await agentsView(ada);
  assert.equal(v.systems[0].keyDrift, null);
});

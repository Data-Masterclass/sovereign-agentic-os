/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Workflows — the workflow store's lifecycle (draft · live · stale) and the approvals
 *             waiting on workflows, with how long they have waited.
 * USER STORY: As a workflow owner or a domain admin I want to see which workflows are drafts, which are live, which
 *             were edited after going live, and which promotion requests have been waiting longest — and I want
 *             "runs" to say that nothing records them, not to show 0.
 * ARCHITECTURE: workflows = the Knowledge store's own scoped list (injected through `sources.ts`, read only);
 *   approvals = the OS approvals store narrowed by Governance's own `canSee`. Twins: another domain's approval and
 *   a non-workflow approval are not shown; a creator sees only their own requests; the approvals store failing is
 *   `unavailable`, not "nothing waiting".
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
let approvalsDown = false;
const at = (h: number) => new Date(Date.parse('2026-11-22T12:00:00Z') - h * 3600_000).toISOString();
const appr = (id: string, o: Record<string, unknown> = {}) => ({
  id, kind: 'artifact_promote', title: `Promote ${id}`, detail: '', agent: 'x', domain: 'sales', requestedBy: 'ada', tool: 't', payload: { artifactKind: 'knowledge', id: `wf-${id}`, name: `WF ${id}` },
  approverRole: 'domain_admin', scope: 'domain', rememberable: false, source: 'Knowledge', status: 'pending', createdAt: at(30), ...o,
});
let all: ReturnType<typeof appr>[] = [];
mock.module('@core/policy/approvals', {
  namedExports: {
    ...(await real('@core/policy/approvals')),
    ensureHydrated: async () => { if (approvalsDown) throw new Error('approvals store not loaded'); },
    listApprovals: (o: { status?: string } = {}) => all.filter((a) => !o.status || a.status === o.status),
  },
});

const { registerMonitoringSources } = await import('./sources');
const { workflowsView } = await import('./workflows-panel');

const wf = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `Process ${id}`, domain: 'sales', scope: 'domain' as const, status: 'live' as const, updatedAt: at(100), publishedAt: at(100), certified: false, ...o });
let rows: ReturnType<typeof wf>[] = [];
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  knowledge: async () => rows,
});
const now = Date.parse('2026-11-22T12:00:00Z');
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const dora = { id: 'dora', name: 'Dora', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'domain_admin' } as never;
const root = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;

beforeEach(() => {
  approvalsDown = false;
  rows = [wf('live1'), wf('draft1', { status: 'draft', publishedAt: null, scope: 'mine' }), wf('stale1', { updatedAt: at(5), publishedAt: at(100) }), wf('cert', { certified: true }), wf('justpub', { updatedAt: at(10), publishedAt: new Date(Date.parse(at(10)) - 4).toISOString() })];
  all = [
    appr('p1', { createdAt: at(30) }),
    appr('p2', { createdAt: at(2), requestedBy: 'bob' }),
    appr('hr', { domain: 'hr', requestedBy: 'zoe', payload: { artifactKind: 'knowledge', id: 'wf-hr', name: 'HR payroll' } }),
    appr('sw', { kind: 'deploy_review', payload: { artifactKind: 'app', id: 'a1' } }),
    appr('done', { status: 'approved', createdAt: at(50), decidedAt: at(40) }),
    appr('done2', { status: 'rejected', createdAt: at(20), decidedAt: at(18) }),
  ];
});

test('lifecycle from the store: draft, live, stale (edited after it went live), certified', async () => {
  const v = await workflowsView(dora, now);
  const by = Object.fromEntries(v.workflows.map((w) => [w.id, w]));
  assert.equal(by.draft1.lifecycle, 'draft');
  assert.equal(by.live1.lifecycle, 'live');
  assert.equal(by.stale1.lifecycle, 'stale');
  assert.equal(by.justpub.lifecycle, 'live', 'twin: the few ms between publishedAt and updatedAt in one publish are not an edit');
  assert.equal(by.cert.certified, true);
  assert.deepEqual({ draft: v.summary!.draft, live: v.summary!.live, stale: v.summary!.stale }, { draft: 1, live: 3, stale: 1 });
});

test('approvals: only workflow promotions, only those the viewer may see (canSee), with wait times', async () => {
  const v = await workflowsView(dora, now);
  assert.deepEqual(v.approvals.pending.map((a) => a.id).sort(), ['p1', 'p2']);
  const p1 = v.approvals.pending.find((a) => a.id === 'p1')!;
  assert.equal(p1.waitingHours, 30);
  assert.equal(p1.approverRole, 'domain_admin');
  assert.equal(v.summary!.oldestWaitHours, 30);
  assert.ok(!JSON.stringify(v).includes('HR payroll'), 'another domain\'s request is invisible');
  assert.ok(!v.approvals.pending.some((a) => a.id === 'sw'), 'a software deploy is not a workflow approval');
});

test('a creator sees only their own requests; an admin sees every domain', async () => {
  assert.deepEqual((await workflowsView(ada, now)).approvals.pending.map((a) => a.id), ['p1']);
  assert.deepEqual((await workflowsView(root, now)).approvals.pending.map((a) => a.id).sort(), ['hr', 'p1', 'p2']);
});

test('decided requests: how many, and the median time to a decision', async () => {
  const v = await workflowsView(dora, now);
  assert.equal(v.approvals.decided.count, 2);
  assert.equal(v.approvals.decided.medianWaitHours, 6, 'median of 10 h and 2 h');
});

test('no decided request: the median is null, not 0', async () => {
  all = all.filter((a) => a.status === 'pending');
  const v = await workflowsView(dora, now);
  assert.equal(v.approvals.decided.count, 0);
  assert.equal(v.approvals.decided.medianWaitHours, null);
});

test('the approvals store failing is unavailable with the reason — not "nothing waiting"', async () => {
  approvalsDown = true;
  const v = await workflowsView(dora, now);
  assert.equal(v.sources.approvals.state, 'unavailable');
  assert.match((v.sources.approvals as { reason: string }).reason, /not loaded/);
  assert.equal(v.approvals.pending.length, 0);
  assert.equal(v.summary!.pendingApprovals, null);
  assert.equal(v.summary!.total, 5, 'the workflow list is unaffected');
});

test('runs are said to be not recorded (and are never a number)', async () => {
  const v = await workflowsView(dora, now);
  const n = v.notUpstream.find((x) => /runs/i.test(x.panel))!;
  assert.ok(n);
  assert.match(n.reason, /run_jobs/);
  assert.ok(!('runs' in v.workflows[0]));
});

test('the workflow reader not registered or failing is unavailable — not "no workflows"', async () => {
  registerMonitoringSources({ agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map() });
  const v = await workflowsView(dora, now);
  assert.equal(v.sources.inventory.state, 'unavailable');
  assert.equal(v.summary, null);
});

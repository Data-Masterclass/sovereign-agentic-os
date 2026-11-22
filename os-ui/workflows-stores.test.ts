/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Workflows over the OS's REAL stores: the Knowledge workflow store and the approvals store,
 *             through the registered reader (`monitoring-sources.ts`) and Governance's `canSee`.
 * USER STORY: As a workflow owner I want the lifecycle and the waiting requests on screen to be what the stores
 *             hold after I really created, published and edited a workflow and asked to promote it.
 * ARCHITECTURE: nothing mocked — the stores are the upstream of this panel. Twins: an edit after publishing turns
 *   the workflow `stale` while a fresh publish does not; a request in another domain is invisible to a domain admin
 *   of this one; deciding the request moves it from waiting to the decided median.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as ks from '@tabs/knowledge/lib/store';
import * as appr from '@core/policy/approvals';
import { registerMonitoringSources } from '@tabs/monitoring/lib/panels/sources';
import { monitoringSourcesImpl } from './monitoring-sources';
import { workflowsView } from '@tabs/monitoring/lib/panels/workflows-panel';

const ada = { id: 'ada', domains: ['sales'], role: 'creator' as const };
const dora = { id: 'dora', domains: ['sales'], role: 'domain_admin' as const };
const hrAdmin = { id: 'hank', domains: ['hr'], role: 'domain_admin' as const };
const asUser = (p: { id: string; domains: string[]; role: string }) => ({ ...p, name: p.id, allDomains: p.domains, activeDomain: null }) as never;

beforeEach(() => { ks.__resetStore(); appr.__resetApprovals(); registerMonitoringSources(monitoringSourcesImpl); });

const ask = (wfId: string, name: string, domain: string, by: string) =>
  appr.enqueue({ kind: 'artifact_promote', title: `Promote ${name}`, detail: '', agent: by, domain, requestedBy: by, tool: 'promote', payload: { artifactKind: 'knowledge', id: wfId, name }, approverRole: 'domain_admin', scope: 'domain', rememberable: false, source: 'Knowledge' });

test('a created draft, a published workflow, one edited after publishing, and a waiting request — as the stores hold them', async () => {
  const draft = ks.createWorkflow(ada, { title: 'Draft idea', domain: 'sales' });
  const published = ks.createWorkflow(ada, { title: 'Refund handling', domain: 'sales' });
  ks.publishWorkflow(published.id, dora);
  const edited = ks.createWorkflow(ada, { title: 'Onboarding', domain: 'sales' });
  ks.publishWorkflow(edited.id, dora);
  await new Promise((r) => setTimeout(r, 300));
  const md = ks.getWorkflow(edited.id, dora).md;
  ks.updateWorkflow(edited.id, dora, { md: md.replace('Onboarding', 'Onboarding v2') });
  ask(published.id, 'Refund handling', 'sales', 'ada');

  const v = await workflowsView(asUser(dora));
  const by = Object.fromEntries(v.workflows.map((w) => [w.title, w]));
  assert.equal(by['Refund handling'].lifecycle, 'live');
  assert.equal(by['Onboarding v2'].lifecycle, 'stale');
  assert.equal(v.workflows.some((w) => w.id === draft.id), false, 'a personal draft of someone else is not in the domain admin\'s list (the store\'s own rule)');
  assert.equal(v.summary!.pendingApprovals, 1);
  assert.equal(v.approvals.pending[0].workflow, 'Refund handling');

  const mine = await workflowsView(asUser(ada));
  assert.equal(mine.workflows.find((w) => w.id === draft.id)!.lifecycle, 'draft');
});

test('twin: a request filed in another domain is invisible to this domain\'s admin, and visible to its own admin', async () => {
  ask('wf-hr', 'HR payroll', 'hr', 'zoe');
  assert.equal((await workflowsView(asUser(dora))).approvals.pending.length, 0);
  assert.equal((await workflowsView(asUser(hrAdmin))).approvals.pending.length, 1);
});

test('deciding the request moves it from waiting to the decided count', async () => {
  const a = ask('wf-1', 'Refunds', 'sales', 'ada');
  assert.equal((await workflowsView(asUser(dora))).approvals.pending.length, 1);
  appr.decide(a.id, 'reject', 'dora');
  const v = await workflowsView(asUser(dora));
  assert.equal(v.approvals.pending.length, 0);
  assert.equal(v.approvals.decided.count, 1);
  assert.ok(v.approvals.decided.medianWaitHours !== null && v.approvals.decided.medianWaitHours >= 0);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Workflows never reads an unloaded store as "nothing there"
 * USER STORY: As a domain admin I must not see "0 pending approvals" or an empty workflow list while the stores behind
 *             them could not be read from OpenSearch; I see the source as unavailable, with the reason.
 * ARCHITECTURE: the REAL approvals and Knowledge stores over the REAL os-mirror; only the HTTP edge to OpenSearch is a
 *   stub — reachable and empty, or no answer (the mirror's own null read, not a throwing mock of the store). Lives at
 *   the os-ui root because a tab test may not import another tab.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let reachable = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!/9200|opensearch/i.test(url)) return realFetch(input, init);
  if (!reachable) throw new Error('connect ECONNREFUSED');
  const body = /_search/.test(url) ? { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } } : { acknowledged: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const ks = await import('@tabs/knowledge/lib/store');
const appr = await import('@core/policy/approvals');
const { registerMonitoringSources } = await import('@tabs/monitoring/lib/panels/sources');
const { monitoringSourcesImpl } = await import('./monitoring-sources');
const { workflowsView } = await import('@tabs/monitoring/lib/panels/workflows-panel');

const dora = { id: 'dora', name: 'dora', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'domain_admin' } as never;

beforeEach(() => {
  reachable = true;
  ks.__resetStore();
  appr.__resetApprovals();
  registerMonitoringSources(monitoringSourcesImpl);
});

test('twin: both stores read an empty index → both sources live, zero pending is a real zero', async () => {
  const v = await workflowsView(dora);
  assert.equal(v.sources.inventory.state, 'live');
  assert.equal(v.sources.approvals.state, 'live');
  assert.equal(v.summary!.pendingApprovals, 0);
});

test('approvals: the mirror read is null → the source is unavailable with a reason and no "0 pending" is claimed', async () => {
  reachable = false;
  const v = await workflowsView(dora);
  assert.equal(appr.approvalsHydrationState(), 'failed');
  assert.equal(v.sources.approvals.state, 'unavailable');
  assert.match(JSON.stringify(v.sources.approvals), /not loaded|could not be read/i);
  assert.deepEqual(v.approvals.pending, []);
  assert.equal(v.summary?.pendingApprovals ?? null, null, 'pendingApprovals is null, never 0, when the store did not load');
});

test('workflows: the Knowledge store hydration was incomplete → the workflow list is unavailable, not empty', async () => {
  reachable = false;
  const v = await workflowsView(dora);
  assert.equal(ks.knowledgeHydrationComplete(), false);
  assert.equal(v.sources.inventory.state, 'unavailable');
  assert.match(JSON.stringify(v.sources.inventory), /not loaded|could not be read/i);
  assert.equal(v.summary, null);
});

test('a failed approvals hydration is retried once the retry window has passed, and then reads live', async () => {
  reachable = false;
  await workflowsView(dora);
  assert.equal(appr.approvalsHydrationState(), 'failed');
  reachable = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    const v = await workflowsView(dora);
    assert.equal(appr.approvalsHydrationState(), 'hydrated');
    assert.equal(v.sources.approvals.state, 'live');
  } finally { Date.now = realNow; }
});

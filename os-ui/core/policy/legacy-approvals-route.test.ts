/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route test for the LEGACY queue door, /api/agent/approvals.
 *
 * It predates the Governance inbox route and kept a role floor ("Builder or above") as its only
 * gate, so it decided ANY approval for any Builder and listed the whole queue to anyone signed
 * in. It now applies the same per-item rule as /api/governance/approvals:
 *  1. the requester of a parked agent run's held call cannot approve it (four-eyes);
 *  2. a Builder of another domain cannot decide, and cannot even see the item;
 *  3. rank still matters — a Builder cannot clear a `domain_admin` item;
 *  4. an authorised approver still can, the effect applies once, a repeat is a 409;
 *  5. GET returns only what the Governance inbox would show that user;
 *  6. a `withdraw` (or any decision this route does not know) is refused — it never approves.
 */

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => ACTING,
    currentUser: async () => ACTING,
  },
});

const { __resetApprovals, __resetDecidedHandlers, enqueue, getApproval, onDecided } = await import('./approvals.ts');

beforeEach(() => {
  __resetApprovals();
  __resetDecidedHandlers();
});

async function loadRoute() {
  return import(`../../app/api/agent/approvals/route.ts?${Math.random()}`);
}

function post(id: string, decision: string = 'approve', headers: Record<string, string> = {}) {
  return new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id, decision }),
  });
}

/** A held call of a PARKED AGENT RUN in `sales`, started by `rae`. */
function seedHeldCall(approverRole: 'builder' | 'domain_admin' = 'builder') {
  return enqueue({
    kind: 'connection_write',
    title: 'Approval needed: request_deploy',
    detail: '',
    agent: 'os-sys1',
    domain: 'sales',
    requestedBy: 'rae',
    tool: 'request_deploy',
    approverRole,
    source: 'Agents',
    payload: { account: 'Acme', field: 'renewal', value: '2026-12-01' },
    runId: 'run_1',
    threadId: 'run_1',
    systemId: 'sys1',
    node: 'deployer',
    runner: { id: 'rae', role: 'builder', domains: ['sales'] },
  });
}

/** An ordinary held connection write in `domain` (no run behind it). */
function seedWrite(domain: string, requestedBy: string) {
  return enqueue({
    kind: 'connection_write',
    title: `CRM write (${domain})`,
    detail: '',
    agent: `agent:${requestedBy}`,
    domain,
    requestedBy,
    tool: 'connection_crm_write',
    payload: { account: 'Acme', field: 'renewal', value: '2026-12-01', secretNote: `${domain}-only` },
  });
}

for (const role of ['builder', 'domain_admin', 'admin'] as const) {
  test(`the run's own requester (${role}) cannot approve their held call through the legacy route`, async () => {
    const a = seedHeldCall('builder');
    let resumed = 0;
    onDecided(() => { resumed += 1; });
    ACTING = { id: 'rae', name: 'Rae', domains: ['sales'], role };
    const res = await (await loadRoute()).POST(post(a.id));
    assert.equal(res.status, 403);
    assert.equal(getApproval(a.id)?.status, 'pending');
    assert.equal(getApproval(a.id)?.decidedBy, undefined);
    assert.equal(resumed, 0, 'the parked run was not resumed');
  });
}

test('a Builder from another domain cannot decide — approve or reject — and the item stays pending', async () => {
  const a = seedWrite('sales', 'amir');
  ACTING = { id: 'fin', name: 'Fin', domains: ['finance'], role: 'builder' };
  const route = await loadRoute();
  for (const decision of ['approve', 'reject'] as const) {
    const res = await route.POST(post(a.id, decision));
    assert.equal(res.status, 403, `${decision} is refused`);
  }
  assert.equal(getApproval(a.id)?.status, 'pending');
});

test('rank is per item: a Builder of the domain cannot clear a domain_admin item; a creator clears nothing', async () => {
  const a = seedHeldCall('domain_admin');
  const route = await loadRoute();
  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };
  assert.equal((await route.POST(post(a.id))).status, 403);
  ACTING = { id: 'carl', name: 'Carl', domains: ['sales'], role: 'creator' };
  assert.equal((await route.POST(post(a.id))).status, 403);
  assert.equal(getApproval(a.id)?.status, 'pending');
});

test('a request that announces itself as an app is refused, as on the Governance route', async () => {
  const a = seedWrite('sales', 'amir');
  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };
  const res = await (await loadRoute()).POST(post(a.id, 'approve', { 'sec-fetch-site': 'cross-site' }));
  assert.equal(res.status, 403);
  assert.equal(getApproval(a.id)?.status, 'pending');
});

test('an authorised approver still decides: the effect applies once, decidedBy is the session user, a repeat is a 409', async () => {
  const a = seedHeldCall('builder');
  const resumed: string[] = [];
  onDecided((_a, d) => { resumed.push(d); });
  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };
  const route = await loadRoute();
  const res = await route.POST(post(a.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approval.status, 'approved');
  assert.match(String(body.applied), /CRM write applied to Acme/);
  assert.equal(getApproval(a.id)?.decidedBy, 'bea');
  const again = await route.POST(post(a.id));
  assert.equal(again.status, 409);
  assert.deepEqual(resumed, ['approve'], 'exactly one decision, exactly one resume');
});

test('GET shows a user only what the Governance inbox would: no other domain, no payload leak', async () => {
  const sales = seedWrite('sales', 'amir');
  const finance = seedWrite('finance', 'fay');
  const route = await loadRoute();
  const idsFor = async (u: NonNullable<typeof ACTING>) => {
    ACTING = u;
    const res = await route.GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pending, body.approvals.length);
    return { ids: (body.approvals as { id: string }[]).map((x) => x.id).sort(), text: JSON.stringify(body) };
  };
  const fin = await idsFor({ id: 'fin', name: 'Fin', domains: ['finance'], role: 'builder' });
  assert.deepEqual(fin.ids, [finance.id]);
  assert.ok(!fin.text.includes('sales-only'), 'another domain\'s payload is not in the response');
  // A creator sees their own requests only — not the rest of their own domain's queue.
  assert.deepEqual((await idsFor({ id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' })).ids, [sales.id]);
  assert.deepEqual((await idsFor({ id: 'cy', name: 'Cy', domains: ['sales'], role: 'creator' })).ids, []);
  assert.deepEqual((await idsFor({ id: 'ada', name: 'Ada', domains: ['platform'], role: 'admin' })).ids, [sales.id, finance.id].sort());
});

test('an item the user cannot see is "not found" on POST — its existence is not confirmed', async () => {
  const a = seedWrite('sales', 'amir');
  ACTING = { id: 'cy', name: 'Cy', domains: ['finance'], role: 'creator' };
  const res = await (await loadRoute()).POST(post(a.id));
  assert.ok(res.status === 403 || res.status === 404);
  assert.equal(getApproval(a.id)?.status, 'pending');
});

test('a `withdraw` posted here NEVER approves — not for an approver, not for the requester — and the run is not resumed', async () => {
  const a = seedHeldCall('builder');
  const resumed: string[] = [];
  onDecided((_a, d) => { resumed.push(d); });
  const route = await loadRoute();
  for (const who of [
    { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' }, // could approve it
    { id: 'rae', name: 'Rae', domains: ['sales'], role: 'builder' }, // the requester
    { id: 'ada', name: 'Ada', domains: ['platform'], role: 'admin' },
  ]) {
    ACTING = who;
    for (const decision of ['withdraw', 'withdrawn', 'APPROVE', 'yes']) {
      const res = await route.POST(post(a.id, decision));
      assert.equal(res.status, 400, `${who.id} posting '${decision}'`);
    }
  }
  assert.equal(getApproval(a.id)?.status, 'pending');
  assert.equal(getApproval(a.id)?.decidedBy, undefined);
  assert.deepEqual(resumed, []);
});

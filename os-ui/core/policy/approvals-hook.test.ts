/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Approval queue A2 semantics — enqueueOnce idempotency and the decide() post-hook
 * USER STORY: As the engine I need one approval per held call however often the node re-runs, and
 *             exactly one resume per decision — a racing second decider must not resume twice.
 * ARCHITECTURE: the real in-process queue (`server-only` neutralised by the test loader), a spy handler.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetApprovals, __resetDecidedHandlers, __simulateRestart, decide, decisionSettled, ensureHydrated, enqueue, enqueueOnce, getApproval, onDecided } from '@core/policy/approvals';

beforeEach(() => { __resetApprovals(); __resetDecidedHandlers(); });

const base = {
  kind: 'connection_write' as const,
  title: 'Approval needed: request_promotion',
  detail: '',
  agent: 'os-sys1',
  domain: 'sales',
  requestedBy: 'rae',
  tool: 'request_promotion',
  runId: 'run_1',
  threadId: 'run_1',
  systemId: 'sys1',
  node: 'writer',
  runner: { id: 'rae', role: 'builder' as const, domains: ['sales'] },
};

test('enqueueOnce: one record per interruptKey, whatever its status', () => {
  const first = enqueueOnce({ ...base, interruptKey: 'run_1:c-1' });
  assert.equal(first.created, true);
  const again = enqueueOnce({ ...base, interruptKey: 'run_1:c-1' });
  assert.equal(again.created, false);
  assert.equal(again.approval.id, first.approval.id);
  decide(first.approval.id, 'approve', 'dana');
  const after = enqueueOnce({ ...base, interruptKey: 'run_1:c-1' });
  assert.equal(after.created, false);
  assert.equal(after.approval.status, 'approved');
  const other = enqueueOnce({ ...base, interruptKey: 'run_1:c-2' });
  assert.equal(other.created, true);
  assert.notEqual(other.approval.id, first.approval.id);
  assert.equal(first.approval.runner?.id, 'rae');
});

test('decide() fires the registered handler exactly once; a racing second decide returns null and fires nothing', async () => {
  const calls: { id: string; decision: string }[] = [];
  onDecided(async (a, d) => { calls.push({ id: a.id, decision: d }); });
  const a = enqueueOnce({ ...base, interruptKey: 'run_1:c-9' }).approval;
  const first = decide(a.id, 'approve', 'dana');
  const second = decide(a.id, 'reject', 'eve');
  assert.ok(first);
  assert.equal(second, null);
  await decisionSettled(a.id);
  assert.deepEqual(calls, [{ id: a.id, decision: 'approve' }]);
  assert.equal(getApproval(a.id)?.decidedBy, 'dana');
});

test('a handler that throws stamps the approval failed and never rejects the decision; non-run approvals fire no handler', async () => {
  let fired = 0;
  onDecided(async () => { fired += 1; throw new Error('resume blew up'); });
  const a = enqueueOnce({ ...base, interruptKey: 'run_1:c-3' }).approval;
  assert.ok(decide(a.id, 'reject', 'dana'));
  await decisionSettled(a.id);
  assert.equal(fired, 1);
  assert.equal(getApproval(a.id)?.resume?.status, 'failed');
  assert.equal(getApproval(a.id)?.resume?.error?.code, 'resume_handler_failed');

  const plain = enqueue({ kind: 'knowledge_certify', title: 't', detail: '', agent: 'a', domain: 'sales', requestedBy: 'rae', tool: 'publish_knowledge' });
  assert.ok(decide(plain.id, 'approve', 'dana'));
  await decisionSettled(plain.id);
  assert.equal(fired, 1, 'no run → no handler');
});

// --------------------------------------------- A2 review M-A: hydrate-after-restart, no duplicate --

test('M-A: after a restart, hydrating from the mirror makes enqueueOnce find the SAME approval (no orphaned duplicate)', async () => {
  // The durable mirror (a stubbed OpenSearch) answers the hydrate search with whatever the old
  // process wrote through. Stub BEFORE the first write so the mirror's probe sees a live cluster.
  const realFetch = globalThis.fetch;
  let stored: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/_search\?size=\d+$/.test(url)) {
      return new Response(JSON.stringify({ hits: { hits: stored ? [{ _source: stored }] : [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/_doc\//.test(url) && (init?.method === 'PUT' || init?.method === 'POST')) {
      stored = JSON.parse(String(init.body)) as Record<string, unknown>; // the write-through
      return new Response('{"result":"created"}', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    // probes / index existence / settings: answer OK
    return new Response(init?.method === 'HEAD' ? null : '{"count":0}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    __resetApprovals(); // forget any dead-mirror verdict from earlier tests
    const first = enqueueOnce({ ...base, interruptKey: 'run_9:c-1' }).approval;
    decide(first.id, 'approve', 'dana');
    await new Promise((r) => setTimeout(r, 20)); // the write-through is fire-and-forget
    assert.ok(stored, 'the decided approval was written through to the mirror');
    __simulateRestart();
    assert.equal(getApproval(first.id), null, 'the in-process queue is empty after the restart');
    await ensureHydrated();
    const again = enqueueOnce({ ...base, interruptKey: 'run_9:c-1' });
    assert.equal(again.created, false, 'a resume after the restart filed a SECOND approval under the same interruptKey');
    assert.equal(again.approval.id, first.id);
    assert.equal(again.approval.status, 'approved', 'the decided approval must be the one the resume reads');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('L-C: deciding a run approval with NO resume handler registered stamps `resume_hook_unregistered` on the record', async () => {
  const a = enqueueOnce({ ...base, interruptKey: 'run_7:c-1' }).approval;
  decide(a.id, 'approve', 'dana');
  await decisionSettled(a.id);
  const after = getApproval(a.id)!;
  assert.equal(after.resume?.status, 'failed');
  assert.equal(after.resume?.error?.code, 'resume_hook_unregistered');
});

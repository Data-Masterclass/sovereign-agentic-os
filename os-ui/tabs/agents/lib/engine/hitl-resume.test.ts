/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-26 strict resume — which pending interrupt a Governance decision answers
 * USER STORY: As an approver I want my decision to resume exactly the call I decided, or nothing:
 *             never a different call, never a guess on a run parked by the previous engine.
 * ARCHITECTURE:
 *   - Pure: `resolveResume` over state snapshots shaped like LangGraph's `getState()` (tasks with
 *     interrupts `{ id, value }`), with the in-memory ApprovalPort. The real-library proof is
 *     `hitl.pg.test.ts`; this pins the shim rules for threads parked before WP-26, which the
 *     current graph can no longer produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import type { HoldDeps } from '@tabs/agents/lib/engine/build-graph';
import { interruptIdOfCard, resolveResume, StaleResumeError } from '@tabs/agents/lib/engine/run';

const RUN = 'run-1';
const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);

function hold(): HoldDeps {
  return {
    decide: (tool) => (tool === 'request_promotion' ? { held: true, approverRole: 'domain_admin' } : { held: false }),
    approvals: memoryApprovalPort(),
    systemId: 's',
    domain: 'sales',
    runner: { id: 'u', role: 'creator', domains: ['sales'] },
    agent: 'os-s',
  };
}

const holdValue = (tool: string) => ({ kind: 'os.hold', tool, node: 'writer', callId: 'c', args: {}, approverRole: 'domain_admin', reason: 'r' });
const legacyValue = (approvalId: string) => ({ approvalId, tool: 'request_promotion', node: 'writer', args: {} });
const snap = (interrupts: { id: string; value: unknown }[], pending: { name: string }[] = []) => ({
  values: { current: { pending: pending.map((p, i) => ({ id: `c${i}`, name: p.name, args: {} })) } },
  tasks: [{ interrupts }],
});

test('a decision naming a pending interrupt id resumes exactly that interrupt', async () => {
  const id = await resolveResume(snap([{ id: HEX_A, value: holdValue('request_promotion') }]), { approvalId: 'apr_1', interruptId: HEX_A, decision: 'approve' }, RUN, hold());
  assert.equal(id, HEX_A);
});

test('a decision naming any other interrupt id is a 409 — and says whether the run still waits', async () => {
  await assert.rejects(
    () => resolveResume(snap([{ id: HEX_A, value: holdValue('request_promotion') }]), { approvalId: 'apr_1', interruptId: HEX_B, decision: 'approve' }, RUN, hold()),
    (e: Error) => e instanceof StaleResumeError && e.status === 409 && e.code === 'stale_interrupt' && e.stillParked,
  );
  await assert.rejects(
    () => resolveResume(snap([]), { approvalId: 'apr_1', interruptId: HEX_A, decision: 'approve' }, RUN, hold()),
    (e: Error) => e instanceof StaleResumeError && !e.stillParked,
  );
});

test('shim: a thread parked by the previous engine with ONE held call resumes through its single interrupt', async () => {
  const s = snap([{ id: HEX_A, value: legacyValue('apr_old') }], [{ name: 'search_knowledge' }, { name: 'request_promotion' }]);
  assert.equal(await resolveResume(s, { approvalId: 'apr_old', decision: 'approve' }, RUN, hold()), HEX_A);
});

test('shim: a pre-WP-26 batch holding MORE than one call is refused (legacy_multi_hold), never guessed', async () => {
  const s = snap([{ id: HEX_A, value: legacyValue('apr_old') }], [{ name: 'request_promotion' }, { name: 'request_promotion' }]);
  await assert.rejects(
    () => resolveResume(s, { approvalId: 'apr_old', decision: 'approve' }, RUN, hold()),
    (e: Error) => e instanceof StaleResumeError && e.code === 'legacy_multi_hold' && e.stillParked === false,
  );
});

test('shim: an approval id that is not the one the old thread parked on resumes nothing', async () => {
  const s = snap([{ id: HEX_A, value: legacyValue('apr_old') }], [{ name: 'request_promotion' }]);
  await assert.rejects(() => resolveResume(s, { approvalId: 'apr_other', decision: 'approve' }, RUN, hold()), (e: Error) => e instanceof StaleResumeError && e.code === 'stale_interrupt');
});

test('interruptIdOfCard: a WP-26 card yields its interrupt id; a pre-WP-26 call-id card yields none', () => {
  assert.equal(interruptIdOfCard(`${RUN}:${HEX_A}`, RUN), HEX_A);
  assert.equal(interruptIdOfCard(`${RUN}:call_abc123`, RUN), undefined);
  assert.equal(interruptIdOfCard(`other:${HEX_A}`, RUN), undefined);
  assert.equal(interruptIdOfCard(undefined, RUN), undefined);
});

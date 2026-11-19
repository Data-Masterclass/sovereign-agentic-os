/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Withdraw a held call — the requester takes back what their own agent run asked for
 * USER STORY: As the person who started an agent run that is parked on a held call, I want to
 *             take that call back myself — on a domain with one admin nobody else can ever decide
 *             it, and the run would wait forever — and have the run continue without it.
 * ARCHITECTURE:
 *   - One function behind the Governance approvals route, so the rule is testable without HTTP:
 *     visible → still pending → a parked run's call → mine (`canWithdraw`) → `withdraw()`.
 *   - `withdraw()` (`approvals.ts`) sets the distinct `withdrawn` status and fires the same
 *     post-decision hook a rejection does: the run resumes as its runner, the held tool is never
 *     executed, and the agent receives the typed `withdrawn_by_requester` result.
 *   - Audited as `approval.withdraw`. Nothing here can approve anything: the only transition it
 *     can make is pending → withdrawn.
 */
import type { Approval } from '@core/policy/approvals';
import { decisionSettled, ensureHydrated, getApproval, withdraw } from '@core/policy/approvals';
import { canSee, canWithdraw, type Actor } from '@core/policy/roles';
import { record as audit } from '@core/policy/audit';

export type WithdrawResult =
  | { ok: true; approval: Approval }
  | { ok: false; status: 403 | 404 | 409; code: 'not_found' | 'forbidden' | 'already_decided' | 'not_a_held_call'; reason: string };

/** Withdraw the held call `approvalId` as `actor`. Waits for the run's resume to be stamped. */
export async function withdrawHeldCall(actor: Actor, approvalId: string): Promise<WithdrawResult> {
  await ensureHydrated();
  const a = getApproval(approvalId);
  // No existence leak: an item the actor cannot see is the same answer as one that is not there.
  if (!a || !canSee(actor, a)) return { ok: false, status: 404, code: 'not_found', reason: 'Request not found' };
  if (a.status !== 'pending') return { ok: false, status: 409, code: 'already_decided', reason: `Already ${a.status} — it can no longer be withdrawn` };
  if (!a.runId) return { ok: false, status: 409, code: 'not_a_held_call', reason: 'Only a call held from an agent run can be withdrawn' };
  if (!canWithdraw(actor, a)) {
    return { ok: false, status: 403, code: 'forbidden', reason: 'Only the person who started the run can withdraw its held call' };
  }
  const done = withdraw(a.id, actor.id);
  // Someone decided it between the read and the write: their decision stands.
  if (!done) return { ok: false, status: 409, code: 'already_decided', reason: `Already ${getApproval(a.id)?.status ?? 'decided'} — it can no longer be withdrawn` };
  audit({
    actor: actor.id,
    action: 'approval.withdraw',
    subject: done.tool || done.kind,
    domain: done.domain,
    reason: `Held call withdrawn by its requester — '${done.tool}' was not executed`,
    detail: { approvalId: done.id, runId: done.runId, systemId: done.systemId, node: done.node },
  });
  await decisionSettled(done.id);
  return { ok: true, approval: getApproval(done.id) ?? done };
}

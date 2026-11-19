/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Approval, ApprovalKind } from '@core/policy/approvals';

/**
 * THE CANONICAL PENDING HANDLE (mcp-v2 P0.1). Every write tool that reaches a
 * `requires_approval` / enqueue outcome returns THIS shape instead of a bare
 * failure — so a gated write is an agent-completable loop (file → poll
 * `get_request` → a decider runs `decide_approval`), never a dead end.
 *
 * `requestId` is the canonical key (= Approval.id); `approvalId` is retained as an
 * ALIAS so the Wave-A/B tests + existing UI keep working unchanged.
 */
export type PendingHandle = {
  status: 'pending';
  requestId: string;
  approvalId: string;
  kind: ApprovalKind;
  whoCanApprove: string;
  hint: string;
};

/**
 * Human "who can approve this", derived from the approver role + scope — and it has to say what
 * `canApprove` (`core/policy/roles.ts`) actually enforces, or the requester goes and asks someone
 * who will be refused. Two things it used to get wrong: a `domain_admin` item was described as
 * "a Builder or Domain-admin" although a Builder is below the rank and is rejected; and nothing
 * said that the runner of a parked agent run can never decide their own run's call.
 */
export function whoCanApprove(a: Pick<Approval, 'approverRole' | 'scope' | 'domain'> & Partial<Pick<Approval, 'runId'>>): string {
  const notRunner = a.runId ? ' — not the person whose agent run asked (a run\'s own runner can never confirm it)' : '';
  if (a.approverRole === 'admin' || a.scope === 'tenant') return `a platform admin${notRunner}`;
  if (a.approverRole === 'domain_admin') return `a Domain-admin of the '${a.domain}' domain, or a platform admin${notRunner}`;
  return `a Builder or Domain-admin in the '${a.domain}' domain${notRunner}`;
}

/** Build the canonical pending handle from an enqueued approval (+ optional extras). */
export function pendingHandle<E extends Record<string, unknown>>(a: Approval, extra?: E): PendingHandle & E {
  const who = whoCanApprove(a);
  return {
    status: 'pending',
    requestId: a.id,
    approvalId: a.id,
    kind: a.kind,
    whoCanApprove: who,
    hint: `Poll get_request('${a.id}'), or ask ${who} to run decide_approval('${a.id}', 'approve').`,
    ...(extra ?? ({} as E)),
  };
}

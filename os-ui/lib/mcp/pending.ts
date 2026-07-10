/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Approval, ApprovalKind } from '@/lib/governance/approvals';

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

/** Human "who can approve this", derived from the approver role + scope. */
export function whoCanApprove(a: Pick<Approval, 'approverRole' | 'scope' | 'domain'>): string {
  if (a.approverRole === 'admin' || a.scope === 'tenant') return 'a platform admin';
  return `a Builder or Domain-admin in the '${a.domain}' domain`;
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

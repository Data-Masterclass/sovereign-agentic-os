/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    useApprovalNotifier — the "request filed" toast after a governed action needs approval
 * USER STORY: As a user who has just filed a promotion, certification or deploy request I want a
 *             toast that says where the request went and links there, plus "Approve now" if I
 *             can approve it, so that I know what happens next.
 * ARCHITECTURE:
 *   - The wording, the `policiesHref` deep link to /governance and the approver check are in the
 *     pure `@core/policy/approval-notice`. The check fails closed. This hook only wires the toast,
 *     the router, `useUser()` and the approve fetch.
 *   - "Approve now" POSTs `{ id, decision: 'approve' }` to `/api/governance/approvals`, the same
 *     route the approvals inbox uses, and throws on failure so the toast button goes back to
 *     idle.
 *   - Called by `PromoteButton` and by the Software, Agents, Knowledge and Files surfaces.
 */
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@core/ui/core/Toast';
import { useUser } from '@core/ui/useUser';
import { approvalNotice, type FiledApproval } from '@core/policy/approval-notice';
import type { ToastAction } from '@core/kernel/toast';

/** POST the approve decision through the governed inbox route. Throws on failure so
 *  the toast's Approve-now button settles back to idle and shows the error toast. */
async function approveRequest(id: string): Promise<void> {
  const res = await fetch('/api/governance/approvals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, decision: 'approve' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? 'Approval failed');
}

export function useApprovalNotifier() {
  const toast = useToast();
  const router = useRouter();
  const { user } = useUser();

  /**
   * Announce a just-filed approval request. `kind` is the human noun for the
   * artifact ('file', 'metric', 'dataset', 'app deploy', 'agent system'…).
   * `onApproved` (optional) runs after a successful inline approve so the host can
   * re-fetch and reflect the now-promoted state.
   */
  const notifyApprovalFiled = useCallback(
    (approval: FiledApproval, kind: string, onApproved?: () => void) => {
      const notice = approvalNotice(approval, kind, user);
      const actions: ToastAction[] = [
        {
          label: 'Go to Policies & Approvals →',
          onClick: () => router.push(notice.policiesHref),
        },
      ];
      if (notice.canApproveInline) {
        actions.push({
          label: 'Approve now',
          busy: true,
          onClick: async () => {
            await approveRequest(notice.requestId);
            toast.success('Approved — the request is cleared.');
            onApproved?.();
          },
        });
      }
      toast.show({ tone: 'info', message: notice.message, actions });
    },
    [toast, router, user],
  );

  return { notifyApprovalFiled };
}

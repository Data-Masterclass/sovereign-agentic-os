/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * useApprovalNotifier — the ONE hook every tab calls right after a governed action
 * FILES an approval request (promote/propose to Domain, certify to Company, request
 * a deploy, promote an agent system…). It fires a single, consistent toast so the
 * user is never left guessing WHERE the request went or how to act on it:
 *
 *   • a calm success line — "Request filed — this <kind> is awaiting approval to
 *     <Domain|Company>. Approve it in Policies & Approvals." —
 *   • a primary  Go to Policies & Approvals →  action that deep-links to /governance
 *     (focused on the just-filed request), and
 *   • IF the signed-in user can actually approve it (an admin/domain_admin at the
 *     target scope — fail-closed), an inline  Approve now  action that POSTs the
 *     decision through the SAME governed route the inbox uses.
 *
 * All the wording + the fail-closed approver gate live in the pure, unit-tested
 * lib/governance/approval-notice.ts; this hook is only the React wiring (toast +
 * router + current user + the approve fetch).
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/core/Toast';
import { useUser } from '@/lib/useUser';
import { approvalNotice, type FiledApproval } from '@/lib/governance/approval-notice';
import type { ToastAction } from '@/lib/core/toast';

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

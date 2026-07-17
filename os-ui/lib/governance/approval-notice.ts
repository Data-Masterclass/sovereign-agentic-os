/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * approval-notice — the pure, framework-free brain behind the ONE OS-wide
 * "this needs approval" confirmation.
 *
 * Across the OS a governed action (promote/propose an artifact to Domain, certify
 * to Company, request a software deploy, promote an agent system…) does NOT take
 * effect immediately — it FILES a request that lands in the Governance › Policies &
 * Approvals inbox. Historically each tab announced that differently and never told
 * the user WHERE the request now lives or how to act on it. This module standardises
 * the wording + the two calls to action, so every tab says the same thing:
 *
 *   1. "Request filed — <artifact> is awaiting approval to <Domain|Company>."
 *      with a  Go to Policies & Approvals →  link to `/governance`.
 *   2. IF the signed-in user can actually approve this very request (an admin /
 *      domain_admin at the target scope), an inline  Approve now  affordance — so
 *      an approver doesn't round-trip through the inbox.
 *
 * The React shell (components/lifecycle/useApprovalNotifier) turns this into a toast
 * with actions; keeping the copy + the fail-closed approver gate here (no React, no
 * DOM, no `server-only`) makes the rules unit-testable in isolation.
 */

import { type Role, roleAtLeast } from '../core/session.ts';
import { type ApproverRole, type ApprovalScope } from './approvals.ts';

/** The minimum an enqueued approval must expose for us to build a notice + gate
 *  the inline approve. Mirrors what every promote/deploy route returns. */
export type FiledApproval = {
  id: string;
  domain: string;
  approverRole: ApproverRole;
  scope: ApprovalScope;
};

/** The signed-in user, as the client `useUser()` hook already exposes them. */
export type NoticeUser = {
  id: string;
  role: Role;
  domains: string[];
};

/** The route the Policies & Approvals inbox lives at. A filed request is focusable
 *  via `?focus=<id>` (the inbox scrolls to + highlights it); harmless if ignored. */
export const POLICIES_PATH = '/governance';

/** Deep-link to Policies & Approvals, optionally focusing a just-filed request. */
export function policiesHref(requestId?: string): string {
  return requestId ? `${POLICIES_PATH}?focus=${encodeURIComponent(requestId)}` : POLICIES_PATH;
}

/**
 * Can THIS user approve THIS filed request inline? The SAME rule the Governance
 * inbox enforces (lib/governance/roles.ts `canApprove`), re-expressed with the
 * client-safe `roleAtLeast`: role rank ≥ the item's required approver AND the item
 * is in the user's scope. Fail-CLOSED — a missing user, unknown role, or an item
 * outside the user's domain(s) returns false, so we never show "Approve now" to
 * someone who would only get a 403.
 *   • scope 'tenant'  → admin only (any domain).
 *   • scope 'domain'  → approverRole+ AND the item's domain is one of theirs.
 *   • scope 'own'     → never inline (it's the requester's own item, not an approval).
 */
export function canApproveInline(user: NoticeUser | null | undefined, a: FiledApproval): boolean {
  if (!user) return false;
  if (!roleAtLeast(user.role, a.approverRole)) return false;
  if (a.scope === 'own') return false;
  if (a.scope === 'tenant') return user.role === 'admin';
  // domain scope: admin sees every domain; everyone else must be IN the domain.
  if (user.role === 'admin') return true;
  return user.domains.includes(a.domain);
}

/** Which rung was this promotion? Drives the "to Domain" / "to Company" wording.
 *  A tenant-scoped / admin-only item is a certification (→ Company); otherwise
 *  it's a promotion (→ Domain). Deploys and other kinds fall back to Domain. */
export function targetScopeWord(a: FiledApproval): 'Domain' | 'Company' {
  return a.scope === 'tenant' || a.approverRole === 'admin' ? 'Company' : 'Domain';
}

/** The fully-resolved notice a tab shows after filing a request. */
export type ApprovalNotice = {
  /** The calm success line. */
  message: string;
  /** Href for the primary "Go to Policies & Approvals →" action. */
  policiesHref: string;
  /** Whether to offer the inline "Approve now" action (fail-closed). */
  canApproveInline: boolean;
  /** The request id, so the inline approve can POST the decision. */
  requestId: string;
};

/**
 * Build the standard notice for a just-filed approval request. `kind` is the human
 * noun for the artifact ("file", "metric", "dataset", "app deploy"…). Wording and
 * both calls-to-action are identical across every tab.
 */
export function approvalNotice(
  a: FiledApproval,
  kind: string,
  user: NoticeUser | null | undefined,
): ApprovalNotice {
  const where = targetScopeWord(a);
  return {
    message: `Request filed — this ${kind} is awaiting approval to ${where}. Approve it in Policies & Approvals.`,
    policiesHref: policiesHref(a.id),
    canApproveInline: canApproveInline(user, a),
    requestId: a.id,
  };
}

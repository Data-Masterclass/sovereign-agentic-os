/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { requestPromotion, promotionStatus, getFile } from '@tabs/files/lib/store';
import { canPromote } from '@core/kernel/session';
import { decide, enqueue, listApprovals, recordEffect } from '@core/policy/approvals';
import { applyEffect } from '@core/policy/effects';
import { buildEffectDeps } from '@core/policy/ladder';
import { record as audit } from '@core/policy/audit';
import type { DataVisibility, Grant } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Promote a file → a domain asset, separation-of-duties (mirrors the Data tab).
 *
 * POST response shape — exactly one of these three, and every caller (FilePreview, the bulk
 * promote in FilesBrowser, the shared <PromoteButton>) must branch on `promoted` / `requested`:
 *   `{ requested: true,  promoted: false, approval }`        a request was FILED
 *   `{ requested: true,  already: true,   approvalId }`      one was already open (handle only)
 *   `{ promoted: true,   requested: false, approvalId, applied, asset }`
 *                                                            the owner-approver's one shot
 * A refusal is `{ error }` carrying the gate's own reason and status — the documentation gate
 * answers 400 `Cannot promote — add a description, at least one tag first.`, and that string is
 * the user's only instruction, so a bulk counter must surface it rather than count it.
 *
 * GET — the docs-gate status + any pending request (so the preview shows it).
 */
export const POST = withRoute<{ id: string }, { visibility?: DataVisibility; grants?: Grant[] }>(async ({ user, params, body }) => {
  const { id } = params;

  // THE OWNER CHECK COMES FIRST. `requestPromotion` is the owner-only trigger and the
  // documentation gate, and it must run BEFORE the duplicate lookup: a dedup that answered
  // first handed any authenticated caller the full pending Approval — file name, owner, domain
  // and the queued payload including its policy grants — for any id they could guess while a
  // request was open.
  const request = requestPromotion(id, user, { visibility: body.visibility, grants: body.grants });

  // Owner proven: a second filing is idempotent, and returns the HANDLE only.
  const existing = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'file_promote' && a.payload?.fileId === id,
  );
  if (existing) return NextResponse.json({ requested: true, already: true, approvalId: existing.id });

  // ONE RECORD, ALWAYS — the owner-approver's one-shot is enqueued too, so no audience move
  // is invisible to the Governance queue or the audit trail.
  const approval = enqueue({
    kind: 'file_promote',
    title: `Promote "${request.fileName}" to a domain asset`,
    detail: `${user.id} requests sharing ${request.fileName} with the ${request.domain} domain (visibility: ${request.visibility}). A domain admin must approve.`,
    agent: user.id,
    domain: request.domain,
    requestedBy: user.id,
    tool: 'file_promote',
    payload: request as unknown as Record<string, unknown>,
    // Personal→Domain is a governed rung: a domain_admin+ approves (a builder is an
    // owner who PROPOSES, not the approver). The inbox `canApprove` gate is the
    // fail-closed enforcement point.
    approverRole: 'domain_admin',
    scope: 'domain',
  });

  if (!canPromote(user.role, 'Personal')) {
    return NextResponse.json({ requested: true, promoted: false, approval });
  }

  // THE OWNER-APPROVER'S ONE SHOT, through the SAME effect seam a Governance decision runs
  // (tier → asset, bytes re-governed to the domain prefix, grants persisted only after
  // `assertGrantsWithinAuthority`), then its own record closed out and audited.
  const effect = await applyEffect(approval, { id: user.id, role: user.role, domains: user.domains }, buildEffectDeps());
  if (!effect.ok) {
    recordEffect(approval.id, { applied: effect.applied, live: false });
    return NextResponse.json({ error: effect.applied, approvalId: approval.id }, { status: 502 });
  }
  decide(approval.id, 'approve', user.id);
  recordEffect(approval.id, { applied: effect.applied, live: effect.live });
  audit({ actor: user.id, action: effect.audit.action, subject: effect.audit.subject, domain: approval.domain, reason: effect.audit.reason, detail: { approvalId: approval.id, ...effect.audit.detail } });
  return NextResponse.json({
    promoted: true,
    requested: false,
    approvalId: approval.id,
    applied: effect.applied,
    asset: getFile(id, user),
  });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const status = promotionStatus(id, user); // view-scope guard + the docs gate
  // Only a still-PENDING request should render as "awaiting approval"; a decided
  // (approved/rejected) one stays in the queue, so an unfiltered lookup would
  // lock the owner out of ever re-requesting after a rejection.
  const pending = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'file_promote' && a.payload?.fileId === id,
  );
  return NextResponse.json({ tier: status.tier, gate: status.gate, request: pending ?? null });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

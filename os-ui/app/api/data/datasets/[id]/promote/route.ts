/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { getDataset, requestPromotion } from '@tabs/data/lib/store';
import { transparencyGate } from '@tabs/data/lib/transparency';
import { canPromote } from '@core/kernel/session';
import { decide, enqueue, listApprovals, recordEffect } from '@core/policy/approvals';
import { applyEffect } from '@core/policy/effects';
import { buildEffectDeps } from '@core/policy/ladder';
import { record as audit } from '@core/policy/audit';
import type { DataVisibility, Grant } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Promotion → Data Asset, separation-of-duties (data-architecture-model.md).
 *
 * POST response shape — exactly one of these three, and every caller (the Data builder, the
 * shared <PromoteButton>, a bulk counter) must branch on `promoted` / `requested`:
 *   `{ requested: true,  promoted: false, approval }`        a request was FILED
 *   `{ requested: true,  already: true,   approvalId }`      one was already open (handle only)
 *   `{ promoted: true,   requested: false, approvalId, applied, dataset, publish }`
 *                                                            the owner-approver's one shot
 * A refusal is `{ error }` with the gate's own status (400/403/409) or 502 when the physical
 * publish failed, in which case the request is left PENDING and the tier unchanged.
 *
 * GET — the transparency gate + this dataset's latest request, for the stepper.
 */
export const POST = withRoute<{ id: string }, { visibility?: DataVisibility; grants?: Grant[] }>(async ({ user, params, body }) => {
  const { id } = params;

  // THE OWNER CHECK COMES FIRST. `requestPromotion` is the owner-only trigger and the
  // Silver/Gold + transparency gate, and it must run BEFORE the duplicate lookup: a dedup that
  // answered first handed any authenticated caller the full pending Approval — dataset name,
  // owner, domain and the queued payload including its policy grants — for any id they could
  // guess while a request was open. Its refusals are byte-identical on both branches below.
  const request = requestPromotion(id, user, { visibility: body.visibility, grants: body.grants });

  // Now that the caller is proven to be the owner, a second filing is idempotent. Return the
  // HANDLE only — the record itself belongs to the Governance inbox, which is scope-filtered.
  const existing = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'dataset_promote' && a.payload?.datasetId === id,
  );
  if (existing) return NextResponse.json({ requested: true, already: true, approvalId: existing.id });

  // ONE RECORD, ALWAYS. Even the owner-approver's one-shot is enqueued first, so the Governance
  // queue and the audit trail show every audience move — an un-recorded promotion is invisible
  // to the people the queue exists for.
  const approval = enqueue({
    kind: 'dataset_promote',
    title: `Promote "${request.datasetName}" to a data asset`,
    detail: `${user.id} requests promoting ${request.datasetName} into ${request.target} (visibility: ${request.visibility}). A domain admin must approve.`,
    agent: user.id,
    domain: request.domain,
    requestedBy: user.id,
    tool: 'data_promote',
    payload: request as unknown as Record<string, unknown>,
    // Personal→Domain is a governed rung: a domain_admin+ approves (a builder is an
    // owner who PROPOSES, not the approver). Matches the MCP request_promotion path
    // + the ladder tabs. The inbox `canApprove` gate is the fail-closed enforcement.
    approverRole: 'domain_admin',
    scope: 'domain',
  });

  // A caller WITHOUT the rung-1 authority stops here: the request is filed and a domain admin
  // decides it. `requested: true` is the shape every other kind's promote route answers.
  if (!canPromote(user.role, 'Personal')) {
    return NextResponse.json({ requested: true, promoted: false, approval });
  }

  // THE OWNER-APPROVER'S ONE SHOT. It runs through the SAME effect seam a Governance decision
  // runs — the governed CTAS as this identity, the independent domain-table probe, the OPA push
  // and the conformance check — then closes its own record out and audits it. Four-eyes bought
  // no second pair of eyes here; it only made the dataset unpromotable.
  const effect = await applyEffect(approval, { id: user.id, role: user.role, domains: user.domains }, buildEffectDeps());
  if (!effect.ok) {
    // Leave the request PENDING and retriable, exactly as the queue path does.
    recordEffect(approval.id, { applied: effect.applied, live: false, publish: effect.publish });
    return NextResponse.json({ error: effect.applied, publish: effect.publish, approvalId: approval.id }, { status: 502 });
  }
  decide(approval.id, 'approve', user.id);
  recordEffect(approval.id, { applied: effect.applied, live: effect.live, publish: effect.publish });
  audit({ actor: user.id, action: effect.audit.action, subject: effect.audit.subject, domain: approval.domain, reason: effect.audit.reason, detail: { approvalId: approval.id, ...effect.audit.detail } });
  return NextResponse.json({
    promoted: true,
    requested: false,
    approvalId: approval.id,
    applied: effect.applied,
    dataset: getDataset(id, user),
    publish: effect.publish,
  });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dataset = getDataset(id, user); // view-scope guard
  // The panel's status source: an in-flight request wins; otherwise the LATEST
  // decided one (so a failed publish shows its real error until re-requested,
  // and a stale earlier decision can't shadow a newer attempt).
  const all = listApprovals().filter(
    (a) => a.kind === 'dataset_promote' && a.payload?.datasetId === id,
  );
  const request =
    all.find((a) => a.status === 'pending') ??
    [...all].sort((x, y) => (y.decidedAt ?? y.createdAt).localeCompare(x.decidedAt ?? x.createdAt))[0] ??
    null;
  return NextResponse.json({ tier: dataset.tier, gate: transparencyGate(dataset), request });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

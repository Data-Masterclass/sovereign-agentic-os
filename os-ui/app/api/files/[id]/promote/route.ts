/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { promoteFileOrPropose, promotionStatus } from '@tabs/files/lib/store';
import { enqueue, listApprovals } from '@core/policy/approvals';
import type { DataVisibility, Grant } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Promote a file → a domain asset, separation-of-duties (mirrors the Data tab):
 *   POST — the OWNER (Creator) REQUESTS promotion; we validate ownership + the
 *          light docs gate (owner + description + ≥1 tag), then enqueue a
 *          `file_promote` into the SHARED approvals queue. A domain admin
 *          approves it in Governance (which applies dataset→asset + re-governs the
 *          object-store prefix + DLS). The Creator cannot self-promote.
 *   GET  — the docs-gate status + any pending request (so the preview shows it).
 */
export const POST = withRoute<{ id: string }, { visibility?: DataVisibility; grants?: Grant[] }>(async ({ user, params, body }) => {
  const { id } = params;

  const existing = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'file_promote' && a.payload?.fileId === id,
  );
  if (existing) return NextResponse.json({ requested: true, approval: existing, already: true });

  // PROMOTE-OR-PROPOSE. An owner who ALSO holds the rung-1 authority (a domain admin or the
  // platform admin sharing their OWN file) is promoted in one shot: `canApprove` refuses the
  // requester whatever their rank, so filing for them would strand the file in My with nobody
  // able to decide. Every gate still runs in the same order — the documentation gate first, so
  // the refusal is byte-identical on both branches.
  const out = promoteFileOrPropose(id, user, { visibility: body.visibility, grants: body.grants });
  if (out.promoted) return NextResponse.json({ promoted: true, asset: out.asset });

  const request = out.request;
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
    // owner who PROPOSES, not the approver). Matches the MCP request_promotion path
    // + the ladder tabs (metrics/artifacts/…). The inbox `canApprove` gate is the
    // fail-closed enforcement point.
    approverRole: 'domain_admin',
    scope: 'domain',
  });
  // `requested: true` is what every other kind's promote route answers and what the shared
  // <PromoteButton> and the Files bulk counter branch on — without it a filed request reads as
  // neither requested nor failed, which is how "0 requested · 1 failed" came to be possible.
  return NextResponse.json({ requested: true, approval });
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

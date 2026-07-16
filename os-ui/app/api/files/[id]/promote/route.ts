/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { requestPromotion, promotionStatus } from '@/lib/files/store';
import { enqueue, listApprovals } from '@/lib/governance/approvals';
import type { DataVisibility, Grant } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Promote a file → a domain asset, separation-of-duties (mirrors the Data tab):
 *   POST — the OWNER (Creator) REQUESTS promotion; we validate ownership + the
 *          light docs gate (owner + description + ≥1 tag), then enqueue a
 *          `file_promote` into the SHARED approvals queue. A domain Builder
 *          approves it in Governance (which applies dataset→asset + re-governs the
 *          object-store prefix + DLS). The Creator cannot self-promote.
 *   GET  — the docs-gate status + any pending request (so the preview shows it).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { visibility?: DataVisibility; grants?: Grant[] };

    const existing = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'file_promote' && a.payload?.fileId === id,
    );
    if (existing) return NextResponse.json({ approval: existing, already: true });

    const request = requestPromotion(id, user, { visibility: body.visibility, grants: body.grants });
    const approval = enqueue({
      kind: 'file_promote',
      title: `Promote “${request.fileName}” to a domain asset`,
      detail: `${user.id} requests sharing ${request.fileName} with the ${request.domain} domain (visibility: ${request.visibility}). A domain Builder must approve.`,
      agent: user.id,
      domain: request.domain,
      requestedBy: user.id,
      tool: 'file_promote',
      payload: request as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ approval });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const status = promotionStatus(id, user); // view-scope guard + the docs gate
    // Only a still-PENDING request should render as "awaiting approval"; a decided
    // (approved/rejected) one stays in the queue, so an unfiltered lookup would
    // lock the owner out of ever re-requesting after a rejection.
    const pending = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'file_promote' && a.payload?.fileId === id,
    );
    return NextResponse.json({ tier: status.tier, gate: status.gate, request: pending ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

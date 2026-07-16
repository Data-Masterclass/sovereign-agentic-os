/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { requestPromotion, getDataset } from '@/lib/data/store';
import { transparencyGate } from '@/lib/data/transparency';
import { enqueue, listApprovals } from '@/lib/governance/approvals';
import type { DataVisibility, Grant } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Promotion → Data Asset, separation-of-duties (data-architecture-model.md):
 *   POST  — the OWNER (Creator) REQUESTS promotion; we validate ownership + the
 *           transparency gate, then enqueue a `dataset_promote` into the SHARED
 *           approvals queue. A domain Builder approves it in Governance (which
 *           applies the dataset→asset move into Trino). The Creator cannot self-promote.
 *   GET   — the request's status for this dataset (so the stepper shows pending/approved).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { visibility?: DataVisibility; grants?: Grant[] };

    // Avoid a duplicate pending request for the same dataset.
    const existing = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'dataset_promote' && a.payload?.datasetId === id,
    );
    if (existing) return NextResponse.json({ approval: existing, already: true });

    const request = requestPromotion(id, user, { visibility: body.visibility, grants: body.grants });
    const approval = enqueue({
      kind: 'dataset_promote',
      title: `Promote “${request.datasetName}” to a data asset`,
      detail: `${user.id} requests promoting ${request.datasetName} into ${request.target} (visibility: ${request.visibility}). A domain Builder must approve.`,
      agent: user.id,
      domain: request.domain,
      requestedBy: user.id,
      tool: 'data_promote',
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
  } catch (e) {
    return errorResponse(e);
  }
}

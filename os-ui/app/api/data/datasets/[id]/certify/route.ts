/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { certify, requestCertification, getDataset } from '@/lib/data/store';
import { enqueue, listApprovals } from '@/lib/approvals';
import type { DataVisibility, Grant, TrustLevel } from '@/lib/data/dataset-schema';

export const dynamic = 'force-dynamic';

/**
 * Certify → Data Product (data-architecture-model.md), Admin-gated:
 *   POST { action:'certify' } — a domain ADMIN certifies directly (OM certification
 *           badge + dataProduct + marketplace listing + broadened visibility).
 *   POST { action:'request' } — a Builder/owner requests certification; an Admin
 *           approves it in Governance (a `dataset_certify` approval). Mirrors promotion.
 *   GET   — the asset's certification status (pending request, if any).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: 'certify' | 'request'; level?: TrustLevel; visibility?: DataVisibility; grants?: Grant[];
    };

    if (body.action === 'certify') {
      const product = certify(id, user, { level: body.level, visibility: body.visibility, grants: body.grants });
      return NextResponse.json({ dataset: product });
    }

    // request → enqueue for an Admin
    const existing = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'dataset_certify' && a.payload?.datasetId === id,
    );
    if (existing) return NextResponse.json({ approval: existing, already: true });

    const request = requestCertification(id, user, { level: body.level, visibility: body.visibility });
    const approval = enqueue({
      kind: 'dataset_certify',
      title: `Certify “${request.datasetName}” as a data product`,
      detail: `${user.id} requests certifying ${request.datasetName} (trust: ${request.level}, visibility: ${request.visibility}) and listing it in the marketplace. A platform Admin must approve.`,
      agent: user.id,
      domain: request.domain,
      requestedBy: user.id,
      tool: 'data_certify',
      payload: request as unknown as Record<string, unknown>,
      // Certification is a platform-Admin decision (tenant scope) — NOT the default
      // builder/domain, so a domain Builder can never approve a marketplace listing.
      approverRole: 'admin',
      scope: 'tenant',
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
    const pending = listApprovals().find(
      (a) => a.kind === 'dataset_certify' && a.payload?.datasetId === id,
    );
    return NextResponse.json({
      tier: dataset.tier,
      certification: dataset.certification ?? null,
      imports: dataset.imports ?? [],
      request: pending ?? null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

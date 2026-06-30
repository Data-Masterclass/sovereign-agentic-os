/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { transitionDashboard } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * Promote (Builder → Domain) / certify (Admin → Marketplace) a dashboard — the same role
 * gate as data + metrics (a non-Builder cannot promote; only an Admin certifies).
 * Broadening the tier never broadens the rows: a shared/certified dashboard stays
 * per-viewer RLS-scoped via the guest token.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { dashboardId?: string; transition?: 'promote' | 'certify' };
    const dashboardId = (body.dashboardId ?? '').trim();
    const transition = body.transition;
    if (!dashboardId || (transition !== 'promote' && transition !== 'certify')) {
      return NextResponse.json({ error: "dashboardId and transition ('promote'|'certify') are required" }, { status: 400 });
    }
    const d = transitionDashboard(dashboardId, user, transition);
    return NextResponse.json({ ok: true, dashboardId, tier: d.tier });
  } catch (e) {
    return errorResponse(e);
  }
}

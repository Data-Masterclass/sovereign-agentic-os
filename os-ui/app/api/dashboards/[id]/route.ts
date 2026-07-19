/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, setDashboardArchived, deleteDashboard, getDashboard } from '@/lib/dashboards/store';
import { deleteDashboardByName } from '@/lib/superset/client';
import { liveDashboardsReachable } from '@/lib/dashboards/build/live-clients';
import { config } from '@/lib/core/config';

export const dynamic = 'force-dynamic';

/**
 * Dashboard lifecycle (owner-scoped): POST { action: 'archive' | 'unarchive' }
 * for the reversible soft-hide, DELETE for the permanent removal (which also
 * purges the dashboard's version history).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action === 'archive' || body.action === 'unarchive') {
      return NextResponse.json({ dashboard: setDashboardArchived(id, user, body.action === 'archive') });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    // Resolve the dashboard name BEFORE removing it from the OS store (we need spec.name
    // to look up the Superset dashboard by title). getDashboard throws 403/404 if the
    // user can't see/delete it — the OS-level auth gate runs before any live call.
    const dash = getDashboard(id, user);
    const dashboardName = dash.spec.name;
    // Best-effort live delete — mode-guarded, reachability-checked, never blocks the OS
    // delete. A Superset failure is logged but doesn't abort the OS deletion (the record
    // is the source of truth; Superset is a delivery artifact).
    try {
      if (await liveDashboardsReachable()) {
        await deleteDashboardByName(config.supersetInternalUrl, dashboardName);
      }
    } catch {
      // Intentionally swallowed: Superset unavailability / title-not-found are non-fatal.
      // The OS store delete proceeds regardless.
    }
    deleteDashboard(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

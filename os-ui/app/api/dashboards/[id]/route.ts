/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, setDashboardArchived, deleteDashboard, getDashboard } from '@/lib/dashboards/store';
import { normalizePanel } from '@/lib/dashboards/model';

export const dynamic = 'force-dynamic';

/**
 * Read one dashboard's spec (view-scoped) — the native View/Design stages need the panel
 * list to render each tile with Apache ECharts on the governed Cube layer. `getDashboard`
 * enforces the tier/ownership gate (403/404), so a viewer only reads a dashboard they may
 * see. Returns the normalized panels so a legacy `{metric}` panel renders natively too.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dash = getDashboard(id, user);
    return NextResponse.json({
      id: dash.id,
      name: dash.spec.name,
      view: dash.spec.view,
      tier: dash.tier,
      panels: dash.spec.charts.map(normalizePanel),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

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
    // getDashboard throws 403/404 if the user can't see/delete it — the OS-level auth gate.
    // Tier-1 native dashboards have no external Superset artifact to clean up.
    getDashboard(id, user);
    deleteDashboard(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

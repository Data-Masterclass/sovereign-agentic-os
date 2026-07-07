/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, setDashboardArchived, deleteDashboard } from '@/lib/dashboards/store';

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
    deleteDashboard(id, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

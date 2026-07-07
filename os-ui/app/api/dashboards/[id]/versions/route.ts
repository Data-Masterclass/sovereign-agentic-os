/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, listDashboardVersions, restoreDashboardVersion } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * Version history for one dashboard.
 *   GET           → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior spec (owner-scoped; snapshots the current
 *                    spec first, so the restore is itself reversible).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const versions = listDashboardVersions(id, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    return NextResponse.json({ dashboard: restoreDashboardVersion(id, user, body.version) });
  } catch (e) {
    return errorResponse(e);
  }
}

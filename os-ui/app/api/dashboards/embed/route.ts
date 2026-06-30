/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { delegatedToken } from '@/lib/identity-server';
import { getDashboard } from '@/lib/dashboards/store';
import { mintEmbed } from '@/lib/dashboards/build/server';

export const dynamic = 'force-dynamic';

/**
 * Double-click a tile → embed. Mints the viewer's Superset guest token with their RLS
 * IN THE TOKEN (R3), so the embedded dashboard shows only the viewer's rows — even on a
 * shared/certified dashboard. Two viewers get two different RLS clauses. The Embedded SDK
 * uses the returned token (~5-min ttl + refresh); the request (resource + rls) is
 * returned so the client can wire the SDK.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { dashboardId?: string; viewerRegion?: string };
    const dashboardId = (body.dashboardId ?? '').trim();
    if (!dashboardId) return NextResponse.json({ error: 'dashboardId is required' }, { status: 400 });

    getDashboard(dashboardId, user); // authorize the open (tier/ownership)
    const { token } = await delegatedToken('domain', { region: body.viewerRegion });
    const minted = await mintEmbed(token, dashboardId);
    return NextResponse.json({ dashboardId, ...minted });
  } catch (e) {
    return errorResponse(e);
  }
}

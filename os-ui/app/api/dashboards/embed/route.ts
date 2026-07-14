/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { delegatedToken } from '@/lib/infra/identity-server';
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

    const dash = getDashboard(dashboardId, user); // authorize the open (tier/ownership)
    const { token } = await delegatedToken('domain', { region: body.viewerRegion });
    // Pass the full spec so the live path can resolve the dashboard → its embedded UUID
    // (the id a guest token must target) and, if the dashboard was never built into
    // Superset yet, build it on the fly from its spec so the embed still mounts.
    // `request.resourceId` is that UUID on the live path, so the frontend SDK mounts by it.
    const minted = await mintEmbed(token, dashboardId, dash.spec);
    return NextResponse.json({ dashboardId, embeddedId: minted.request.resourceId, ...minted });
  } catch (e) {
    return errorResponse(e);
  }
}

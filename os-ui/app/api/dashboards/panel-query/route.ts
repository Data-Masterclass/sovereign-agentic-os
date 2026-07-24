/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { delegatedToken } from '@/lib/infra/identity-server';
import { runPanelQuery } from '@/lib/dashboards/build/panel-query';
import type { Panel } from '@/lib/dashboards/model';

export const dynamic = 'force-dynamic';

/**
 * Resolve ONE native dashboard panel's rows (Tier 1) — the viewer opens a panel and it
 * renders with Apache ECharts on the governed Cube layer. The query runs UNDER THE
 * VIEWER'S delegated identity (R3): per-viewer Cube RLS via the security context, so two
 * viewers of the SAME dashboard see DIFFERENT rows. `viewerRegion` is the demo "view as"
 * affordance (production reads region from the Ory JWT). No Cube URL/token ever reaches
 * the browser — the panel gets only rows + mode + the query it ran.
 */
export async function POST(req: Request) {
  try {
    await requirePrincipal(); // authenticate (and hydrate) before resolving identity
    const body = (await req.json().catch(() => ({}))) as {
      view?: string;
      panel?: Panel;
      viewerRegion?: string;
    };
    const view = (body.view ?? '').trim();
    const panel = body.panel;
    if (!view) return NextResponse.json({ error: 'view is required' }, { status: 400 });
    if (!panel || typeof panel !== 'object') return NextResponse.json({ error: 'panel is required' }, { status: 400 });

    const { token } = await delegatedToken('domain', { region: body.viewerRegion });
    const result = await runPanelQuery(view, panel, token);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

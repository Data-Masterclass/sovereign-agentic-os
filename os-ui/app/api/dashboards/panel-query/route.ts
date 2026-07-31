/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
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
export const POST = withRoute<Record<string, string>, {
  view?: string;
  panel?: Panel;
  viewerRegion?: string;
}>(async ({ user, body }) => {
  const view = (body.view ?? '').trim();
  const panel = body.panel;
  if (!view) return NextResponse.json({ error: 'view is required' }, { status: 400 });
  if (!panel || typeof panel !== 'object') return NextResponse.json({ error: 'panel is required' }, { status: 400 });

  // The viewer's delegated token drives per-viewer RLS; `user` scopes the registry resolver
  // (Phase 2: the panel resolves its numbers through the governed-SQL metrics path, not Cube).
  const { token } = await delegatedToken('domain', { region: body.viewerRegion });
  const result = await runPanelQuery(view, panel, token, user);
  return NextResponse.json(result);
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });

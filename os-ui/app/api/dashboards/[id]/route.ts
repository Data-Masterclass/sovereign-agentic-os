/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { ensureHydrated, setDashboardArchived, deleteDashboard, getDashboard } from '@/lib/dashboards/store';
import { normalizePanel } from '@/lib/dashboards/model';

export const dynamic = 'force-dynamic';

/**
 * Read one dashboard's spec (view-scoped) — the native View/Design stages need the panel
 * list to render each tile with Apache ECharts on the governed Cube layer. `getDashboard`
 * enforces the tier/ownership gate (403/404), so a viewer only reads a dashboard they may
 * see. Returns the normalized panels so a legacy `{metric}` panel renders natively too.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const dash = getDashboard(id, user);
  return NextResponse.json({
    id: dash.id,
    name: dash.spec.name,
    view: dash.spec.view,
    tier: dash.tier,
    panels: dash.spec.charts.map(normalizePanel),
  });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

/**
 * Dashboard lifecycle (owner-scoped): POST { action: 'archive' | 'unarchive' }
 * for the reversible soft-hide, DELETE for the permanent removal (which also
 * purges the dashboard's version history).
 */
export const POST = withRoute<{ id: string }, { action?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (body.action === 'archive' || body.action === 'unarchive') {
    return NextResponse.json({ dashboard: setDashboardArchived(id, user, body.action === 'archive') });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });

export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  // getDashboard throws 403/404 if the user can't see/delete it — the OS-level auth gate.
  // Tier-1 native dashboards have no external Superset artifact to clean up.
  getDashboard(id, user);
  deleteDashboard(id, user);
  return NextResponse.json({ ok: true });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

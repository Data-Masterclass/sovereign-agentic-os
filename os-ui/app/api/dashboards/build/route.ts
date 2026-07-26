/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { saveDashboard } from '@/lib/dashboards/store';
import { type Panel, fromAgent, fromTiles } from '@/lib/dashboards/model';

export const dynamic = 'force-dynamic';

/**
 * Persist a dashboard — DUAL-MODE (drag-and-drop panels OR the dashboard agent) both land
 * the SAME spec (panels reference governed metric members). Tier-1 native dashboards render
 * with Apache ECharts on the governed Cube layer at VIEW time (per-viewer RLS via
 * /api/dashboards/panel-query) — there is no Superset build/import step anymore, so this
 * route is persist-only. The domain scopes the dashboard's governed view; the caller's
 * first domain is used.
 */
export const POST = withRoute<Record<string, string>, {
  id?: string;
  name?: string;
  view?: string;
  mode?: 'drag-drop' | 'agent';
  charts?: Panel[];
}>(async ({ user, body }) => {
  const id = (body.id ?? '').trim();
  const name = (body.name ?? '').trim();
  const view = (body.view ?? '').trim();
  if (!id || !name || !view) return NextResponse.json({ error: 'id, name and view are required' }, { status: 400 });
  const charts = body.charts ?? [];
  if (charts.length === 0) return NextResponse.json({ error: 'a dashboard needs at least one panel on a governed metric' }, { status: 400 });

  const domain = user.domains[0];
  const spec = body.mode === 'agent' ? fromAgent({ name, view, charts, domain }) : fromTiles(name, view, charts, domain);
  const rec = saveDashboard(user, id, spec);
  return NextResponse.json({ id, spec: { name: rec.spec.name, view: rec.spec.view, charts: rec.spec.charts } });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });

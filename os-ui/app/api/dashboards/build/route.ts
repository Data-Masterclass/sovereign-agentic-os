/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { delegatedToken } from '@/lib/identity-server';
import { saveDashboard } from '@/lib/dashboards/store';
import { type ChartSpec, fromAgent, fromTiles } from '@/lib/dashboards/model';
import { type AlertRule } from '@/lib/metrics/alerts';
import { buildDashboard } from '@/lib/dashboards/build/server';

export const dynamic = 'force-dynamic';

/**
 * Build a dashboard DUAL-MODE — drag-and-drop charts OR the dashboard agent — both land
 * the SAME spec (charts reference governed metric members). We save it, then run the
 * superset/embed/report/alert Build (LIVE Superset or offline-mock). The embed adapter
 * verifies the guest-token request carries the builder's RLS (R3).
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      view?: string;
      mode?: 'drag-drop' | 'agent';
      charts?: ChartSpec[];
      report?: { cadence: string; channel: string };
      alert?: AlertRule;
    };
    const id = (body.id ?? '').trim();
    const name = (body.name ?? '').trim();
    const view = (body.view ?? '').trim();
    if (!id || !name || !view) return NextResponse.json({ error: 'id, name and view are required' }, { status: 400 });
    const charts = body.charts ?? [];
    if (charts.length === 0) return NextResponse.json({ error: 'a dashboard needs at least one chart on a governed metric' }, { status: 400 });

    const spec = body.mode === 'agent' ? fromAgent({ name, view, charts }) : fromTiles(name, view, charts);
    saveDashboard(user, id, spec);

    const { token } = await delegatedToken('domain');
    const build = await buildDashboard(spec, token, id, { report: body.report, alert: body.alert });
    return NextResponse.json({ id, spec, build });
  } catch (e) {
    return errorResponse(e);
  }
}

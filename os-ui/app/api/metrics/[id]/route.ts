/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getMetric } from '@/lib/metrics/store';
import {
  ensureHydrated,
  isMetricArchived,
  archiveMetric,
  unarchiveMetric,
  deleteMetric,
} from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * One metric's lifecycle — the SAME `POST {action}` / `DELETE` shape every other
 * artifact tab exposes, wiring the already-built `lib/metrics/lifecycle` overlay so
 * the shared <LifecycleActions> can drive Metrics identically. Edit authority is the
 * metric's dataset gate (owner or domain admin), enforced in the lib.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const metric = getMetric(id, user);
    return NextResponse.json({ metric: { ...metric, archived: isMetricArchived(id) } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST → metric lifecycle: `archive` (reversible soft-hide) or `unarchive`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case 'archive':
        return NextResponse.json({ metric: archiveMetric(id, user) });
      case 'unarchive':
        return NextResponse.json({ metric: unarchiveMetric(id, user) });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * DELETE → permanently remove a metric (edit-scoped; confirmed in the UI). Snapshots
 * the measure for restore, then de-registers it from its Cube model so it stops being
 * queryable. Honest `{ recordDeleted, physical[] }` report.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const report = deleteMetric(id, user);
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return errorResponse(e);
  }
}

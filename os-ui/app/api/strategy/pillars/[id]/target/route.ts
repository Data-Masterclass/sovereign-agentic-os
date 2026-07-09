/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { setHeadlineTarget } from '@/lib/strategy/pillars';
import { METRIC_TYPES, HORIZONS, type MetricType, type Horizon } from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

/**
 * Set the pillar's HEADLINE target — the card's big number: a target value tied
 * to a metric TYPE (EBIT/Revenue/Time Back Hours/# Risks Mitigated/Custom) and a
 * horizon (year-end · 6/12/24/36-month), whose end date the server derives.
 * Builder (domain) / Admin (tenant); audited.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const value = Number(body?.value);
    const metricType = METRIC_TYPES.includes(body?.metricType as MetricType)
      ? (body.metricType as MetricType)
      : 'ebit';
    const horizon = HORIZONS.includes(body?.horizon as Horizon)
      ? (body.horizon as Horizon)
      : 'year-end';
    const item = await setHeadlineTarget(user, id, { value, metricType, horizon });
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { setHeadlineTarget } from '@/lib/strategy/pillars';
import { METRIC_TYPES, HORIZONS, type MetricType, type Horizon } from '@/lib/strategy';

export const dynamic = 'force-dynamic';

/**
 * Set the pillar's HEADLINE target — the card's big number: a target value tied
 * to a metric TYPE (EBIT/Revenue/Time Back Hours/# Risks Mitigated/Custom) and a
 * horizon (year-end · 6/12/24/36-month), whose end date the server derives.
 * Builder (domain) / Admin (tenant); audited.
 */
export const PUT = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
  const { id } = params;
  const value = Number(body?.value);
  const metricType = METRIC_TYPES.includes(body?.metricType as MetricType)
    ? (body.metricType as MetricType)
    : 'ebit';
  const horizon = HORIZONS.includes(body?.horizon as Horizon)
    ? (body.horizon as Horizon)
    : 'year-end';
  const item = await setHeadlineTarget(user, id, { value, metricType, horizon });
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });

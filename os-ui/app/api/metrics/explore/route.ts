/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { delegatedToken } from '@/lib/infra/identity-server';
import { getMetric } from '@/lib/metrics/store';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';

export const dynamic = 'force-dynamic';

/**
 * Explore a metric — pick a metric + slice, no SQL. The query runs UNDER the viewer's
 * delegated identity (R3): per-viewer Cube RLS via the security context, so two viewers
 * see DIFFERENT rows. `viewerRegion` is the demo "view as" affordance (production reads
 * region from the Ory JWT). Returns the rows + the SQL an analyst would drop to.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as {
      metricId?: string;
      dimensions?: string[];
      timeDimension?: string;
      granularity?: Granularity;
      viewerRegion?: string;
    };
    const metricId = (body.metricId ?? '').trim();
    if (!metricId) return NextResponse.json({ error: 'metricId is required' }, { status: 400 });

    const record = getMetric(metricId, user);
    const { token } = await delegatedToken('domain', { region: body.viewerRegion });
    const result = await exploreMetric(record.dataset, record.measure, token, {
      dimensions: body.dimensions,
      timeDimension: body.timeDimension,
      granularity: body.granularity,
    });
    return NextResponse.json({ metricId, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}

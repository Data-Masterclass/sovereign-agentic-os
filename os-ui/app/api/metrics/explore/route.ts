/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { delegatedToken } from '@/lib/infra/identity-server';
import { getMetric } from '@/lib/metrics/store';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { appSlugFromRequest, checkAppGrant } from '@/lib/software/app-origin';

export const dynamic = 'force-dynamic';

/**
 * Explore a metric — pick a metric + slice, no SQL. The query runs UNDER the viewer's
 * delegated identity (R3): per-viewer Cube RLS via the security context, so two viewers
 * see DIFFERENT rows. `viewerRegion` is the demo "view as" affordance (production reads
 * region from the Ory JWT). Returns the rows + the SQL an analyst would drop to.
 */
export const POST = withRoute<Record<string, string>, {
  metricId?: string;
  dimensions?: string[];
  timeDimension?: string;
  granularity?: Granularity;
  viewerRegion?: string;
  /** Equality cross-filters (P1-4) — the chip vocabulary; reconciled loudly by exploreMetric
   *  (a non-view column is dropped + reported, never silently applied). */
  filters?: { column: string; values: string[] }[];
}>(async ({ user, body, req }) => {
  const metricId = (body.metricId ?? '').trim();
  if (!metricId) return NextResponse.json({ error: 'metricId is required' }, { status: 400 });

  // LEAST-PRIVILEGE for app origins: a deployed app may only explore a metric it was
  // granted. Non-app requests (the OS UI) skip this (appSlugFromRequest → null).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const check = await checkAppGrant(slug, 'metrics', metricId);
    if (!check.allowed) return NextResponse.json({ error: check.reason }, { status: 403 });
  }

  const record = getMetric(metricId, user);
  const { token } = await delegatedToken('domain', { region: body.viewerRegion });
  const result = await exploreMetric(record.dataset, record.measure, token, {
    dimensions: body.dimensions,
    timeDimension: body.timeDimension,
    granularity: body.granularity,
    filters: body.filters,
  });
  return NextResponse.json({ metricId, ...result });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, parse: true });

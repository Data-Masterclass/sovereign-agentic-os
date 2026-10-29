/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { safeSummariesFor } from '@tabs/metrics/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Metrics defined on THIS dataset — the reverse list the Data tab's Publish stage shows
 * ("metrics on this dataset", each linking to the Metrics tab). Read-only over the metric
 * registry (a metric IS a measure on a governed dataset), fail-soft per {@link safeSummariesFor}.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  return NextResponse.json({ metrics: safeSummariesFor(id, user) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { safeSummariesFor } from '@/lib/metrics/store';

export const dynamic = 'force-dynamic';

/**
 * Metrics defined on THIS dataset — the reverse list the Data tab's Publish stage shows
 * ("metrics on this dataset", each linking to the Metrics tab). Read-only over the metric
 * registry (a metric IS a measure on a governed dataset), fail-soft per {@link safeSummariesFor}.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    return NextResponse.json({ metrics: safeSummariesFor(id, user) });
  } catch (e) {
    return errorResponse(e);
  }
}

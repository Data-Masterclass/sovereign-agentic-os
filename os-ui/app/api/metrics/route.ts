/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listMetrics } from '@/lib/metrics/store';

export const dynamic = 'force-dynamic';

/**
 * The governed metric registry — every measure the user can see, grouped Mine / Domain /
 * Marketplace, each with its canonical Cube member (the single source of the number that
 * the explorer, dashboards and the agent `metrics` tool all resolve). Derived read-only
 * from the Data tab's datasets, so defining a measure is the single write.
 */
export async function GET() {
  try {
    const user = await requirePrincipal();
    return NextResponse.json(listMetrics(user));
  } catch (e) {
    return errorResponse(e);
  }
}

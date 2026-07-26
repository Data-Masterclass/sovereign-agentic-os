/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { ACTIVITIES, TIER_MODELS, defaultRoutingTable } from '@/lib/agents/routing';

export const dynamic = 'force-dynamic';

/** GET → the workspace default activity→model routing table (standard/reasoning/vision tiers). */
export async function GET() {
  // No anon access — any signed-in user may read the routing table (consistency with
  // the other /api/agents/* routes, which all gate on requireUser).
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  return NextResponse.json({
    activities: ACTIVITIES,
    tiers: TIER_MODELS,
    table: defaultRoutingTable(),
  });
}

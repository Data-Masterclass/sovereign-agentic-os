/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ACTIVITIES, TIER_MODELS, defaultRoutingTable } from '@/lib/agents/routing';

export const dynamic = 'force-dynamic';

/** GET → the workspace default activity→model routing table (standard/reasoning/vision tiers). */
// No anon access — any signed-in user may read the routing table (consistency with
// the other /api/agents/* routes, which all gate on requireUser).
export const GET = withRoute(async () => {
  return NextResponse.json({
    activities: ACTIVITIES,
    tiers: TIER_MODELS,
    table: defaultRoutingTable(),
  });
}, { defaultStatus: 401 });

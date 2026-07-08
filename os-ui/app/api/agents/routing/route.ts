/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { ACTIVITIES, TIER_MODELS, defaultRoutingTable } from '@/lib/agents/routing';

export const dynamic = 'force-dynamic';

/** GET → the workspace default activity→model routing table (standard/reasoning/vision tiers). */
export async function GET() {
  return NextResponse.json({
    activities: ACTIVITIES,
    tiers: TIER_MODELS,
    table: defaultRoutingTable(),
  });
}

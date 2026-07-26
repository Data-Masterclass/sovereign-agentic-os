/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { strategyScorecard } from '@/lib/strategy/scorecard';

export const dynamic = 'force-dynamic';

/**
 * The Strategy tab's Self Service + Foundations numbers, RLS-scoped to the
 * caller's company/domain. Derived live from the registry + user roster — no
 * hand-kept figures.
 */
export const GET = withRoute(async ({ user }) => {
  const scorecard = await strategyScorecard(user);
  return NextResponse.json(scorecard);
}, { defaultStatus: 500 });

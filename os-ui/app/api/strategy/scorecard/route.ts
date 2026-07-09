/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { strategyScorecard } from '@/lib/strategy/scorecard';

export const dynamic = 'force-dynamic';

/**
 * The Strategy tab's Self Service + Foundations numbers, RLS-scoped to the
 * caller's company/domain. Derived live from the registry + user roster — no
 * hand-kept figures.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const scorecard = await strategyScorecard(user);
    return NextResponse.json(scorecard);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { assertInScope, fetchTrace, scopeForUser } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

/**
 * GET /api/monitoring/trace/[id] — DRILL INTO ONE TRACE (steps · tool calls · the
 * context pack · inputs/outputs · logs). The core promise of the tab.
 *
 * SECURITY GATE (validation gate): the trace is fetched, then `assertInScope`
 * throws 403 unless the viewer is entitled — so a User CANNOT open another user's
 * trace by guessing its id. The scope check is on the SAME identity the overview
 * uses; there is no privileged side-channel.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const scope = await scopeForUser(user);
    const { id } = await ctx.params;

    const trace = await fetchTrace(id);
    // Throws 404 if missing, 403 if out of scope — before any step/log is returned.
    assertInScope(scope, trace);

    return NextResponse.json({ trace });
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

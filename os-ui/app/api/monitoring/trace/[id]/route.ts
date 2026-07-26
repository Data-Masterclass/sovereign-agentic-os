/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
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
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const scope = await scopeForUser(user);
  const { id } = params;

  const trace = await fetchTrace(id);
  // Throws 404 if missing, 403 if out of scope — before any step/log is returned.
  assertInScope(scope, trace);

  return NextResponse.json({ trace });
}, { defaultStatus: 500 });

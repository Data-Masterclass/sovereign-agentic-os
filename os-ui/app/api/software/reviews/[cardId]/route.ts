/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getReviewCard, decideDeploy } from '@tabs/software/lib/review';

export const dynamic = 'force-dynamic';

/** One review card's full detail (scan + requested resources + footprint + diff). */
export const GET = withRoute<{ cardId: string }>(async ({ params }) => {
  const { cardId } = params;
  const card = await getReviewCard(cardId);
  if (!card) return NextResponse.json({ error: 'Review card not found' }, { status: 404 });
  return NextResponse.json({ card });
}, { defaultStatus: 500 });

/**
 * Decide a deploy. THE ROLE GATE lives in `decideDeploy`: only a Builder/Admin in
 * the app's domain may approve/deny — a non-Builder gets 403, and a failing
 * security scan blocks approval (409). Identical whether reached from the UI or
 * the Platform MCP.
 *
 * `acknowledgeNoScan` + `reason` are the audited, ADMIN-ONLY hatch for a scan that produced no
 * verdict (2026-11-19). Both are forwarded verbatim and every gate is enforced in
 * `decideDeploy` — the role, the fact that the scan is `unavailable` rather than failed, and the
 * reason's length — so this route adds no authority of its own.
 */
export const POST = withRoute<
  { cardId: string },
  { decision?: string; note?: string; acknowledgeNoScan?: boolean; reason?: string }
>(async ({ user, params, body }) => {
  const { cardId } = params;
  const decision = body.decision === 'approve' ? 'approve' : 'deny';
  const result = await decideDeploy(cardId, user, decision, body.note, {
    acknowledgeNoScan: body.acknowledgeNoScan === true,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
  return NextResponse.json(result);
}, { parse: true, defaultStatus: 500 });

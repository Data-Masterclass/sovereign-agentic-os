/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getReviewCard, decideDeploy } from '@/lib/software/review';

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
 */
export const POST = withRoute<{ cardId: string }, { decision?: string; note?: string }>(async ({ user, params, body }) => {
  const { cardId } = params;
  const decision = body.decision === 'approve' ? 'approve' : 'deny';
  const result = await decideDeploy(cardId, user, decision, body.note);
  return NextResponse.json(result);
}, { parse: true, defaultStatus: 500 });

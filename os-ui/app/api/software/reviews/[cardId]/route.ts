/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getReviewCard, decideDeploy } from '@/lib/software/review';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** One review card's full detail (scan + requested resources + footprint + diff). */
export async function GET(_req: Request, ctx: { params: Promise<{ cardId: string }> }) {
  try {
    await requireUser();
    const { cardId } = await ctx.params;
    const card = getReviewCard(cardId);
    if (!card) return NextResponse.json({ error: 'Review card not found' }, { status: 404 });
    return NextResponse.json({ card });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Decide a deploy. THE ROLE GATE lives in `decideDeploy`: only a Builder/Admin in
 * the app's domain may approve/deny — a non-Builder gets 403, and a failing
 * security scan blocks approval (409). Identical whether reached from the UI or
 * the Platform MCP.
 */
export async function POST(req: Request, ctx: { params: Promise<{ cardId: string }> }) {
  try {
    const user = await requireUser();
    const { cardId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { decision?: string; note?: string };
    const decision = body.decision === 'approve' ? 'approve' : 'deny';
    const result = await decideDeploy(cardId, user, decision, body.note);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}

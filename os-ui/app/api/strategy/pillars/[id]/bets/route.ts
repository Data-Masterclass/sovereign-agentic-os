/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { linkBet, unlinkBet } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/** Link a Big Bet to the pillar (Builder/Admin). Stubs the share via the bridge. */
export const POST = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
  const { id } = params;
  const betId = String(body?.betId ?? '');
  if (!betId) return NextResponse.json({ error: 'A betId is required' }, { status: 400 });
  const item = await linkBet(user, id, betId);
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });

/** Unlink a Big Bet (Builder/Admin). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const { searchParams } = new URL(req.url);
  const betId = searchParams.get('betId') ?? '';
  if (!betId) return NextResponse.json({ error: 'A betId is required' }, { status: 400 });
  const item = await unlinkBet(user, id, betId);
  return NextResponse.json({ item });
}, { defaultStatus: 500 });

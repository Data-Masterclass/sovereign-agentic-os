/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { linkBet, unlinkBet } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Link a Big Bet to the pillar (Builder/Admin). Stubs the share via the bridge. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const betId = String(body?.betId ?? '');
    if (!betId) return NextResponse.json({ error: 'A betId is required' }, { status: 400 });
    const item = await linkBet(user, id, betId);
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

/** Unlink a Big Bet (Builder/Admin). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { searchParams } = new URL(req.url);
    const betId = searchParams.get('betId') ?? '';
    if (!betId) return NextResponse.json({ error: 'A betId is required' }, { status: 400 });
    const item = await unlinkBet(user, id, betId);
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

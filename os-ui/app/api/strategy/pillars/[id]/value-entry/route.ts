/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { addValueEntry } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Record a manual monthly value for the pillar's value metric (mode='manual').
 * The newest entry is the headline total; the series feeds the value-history
 * chart. Builder (domain) / Admin (tenant); audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const value = Number(body?.value);
    const month = typeof body?.month === 'string' ? body.month : undefined;
    const item = await addValueEntry(user, id, { value, month });
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { demotePillar } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Revoke sharing on a pillar ONE tier down: Company → Domain (Admin) → My (owner /
 * in-domain Builder+ / Admin). Runs through the role-gated `demotePillar` (mirrors
 * the OS artifact demote ladder). Never deletes the pillar — only lowers its tier.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const item = await demotePillar(user, id);
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

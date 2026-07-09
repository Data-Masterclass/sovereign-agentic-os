/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getPillar } from '@/lib/strategy/pillars';
import { recordSnapshot } from '@/lib/strategy/snapshots';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Capture a monthly actuals snapshot for the pillar (Builder/Admin, audited). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const pillar = await getPillar(user, id);
    const snapshot = await recordSnapshot(user, pillar);
    return NextResponse.json({ snapshot });
  } catch (e) {
    return fail(e);
  }
}

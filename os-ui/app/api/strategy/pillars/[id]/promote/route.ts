/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { promotePillar } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Promote a pillar ONE tier up — the SAME shared <PromoteButton> contract every OS
 * tab speaks (Metrics/Dashboards/Science). Pillars promote DIRECTLY (role-gated in
 * `promotePillar`: Builder+ to Domain, Admin to Company) with no approval queue, so
 * there is never a pending request:
 *   • GET  → `{ request: null }` (the button pre-checks for a pending request).
 *   • POST → promotes in one shot → `{ item }`; a non-approver hits the store's 403.
 */
export async function GET(_req: Request, _ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    return NextResponse.json({ request: null });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const item = await promotePillar(user, id);
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

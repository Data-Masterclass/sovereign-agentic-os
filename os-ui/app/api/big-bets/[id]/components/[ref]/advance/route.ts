/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { advanceComponent } from '@/lib/bigbets/store';
import { actor } from '@/lib/bigbets/server';
import { type Lifecycle } from '@/lib/bigbets';

export const dynamic = 'force-dynamic';

const LIFECYCLES: Lifecycle[] = [
  'planned', 'building', 'draft', 'staging', 'untested',
  'certified', 'promoted', 'published', 'deployed', 'live', 'production', 'tested-governed',
];

/**
 * POST → advance a component through its tab's governed lifecycle (build →
 * certify/promote/publish/deploy/go-live). Promotion is human-only: the store +
 * source reject a planner actor for any ready transition, so this route only ever
 * runs as the authenticated human.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; ref: string }> }) {
  try {
    const user = await requireUser();
    const { id, ref } = await ctx.params;
    const b = await req.json().catch(() => ({}));
    if (!LIFECYCLES.includes(b.to)) return NextResponse.json({ error: `to must be one of ${LIFECYCLES.join(', ')}` }, { status: 400 });
    advanceComponent(id, actor(user), ref, b.to);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

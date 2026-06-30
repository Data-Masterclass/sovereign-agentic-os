/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { setValueMetric } from '@/lib/strategy/pillars';
import type { ValueMode } from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

const MODES: ValueMode[] = ['describe', 'governed', 'manual'];

/**
 * Describe (or update) a pillar's value metric: its name, one-line description,
 * and how its number is kept — described-only, governed (set up in the Metrics
 * tab), or manual monthly entries. Builder (domain) / Admin (tenant); audited.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const mode = MODES.includes(body?.mode as ValueMode) ? (body.mode as ValueMode) : undefined;
    const item = await setValueMetric(user, id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      description: body?.description !== undefined ? String(body.description) : undefined,
      mode,
    });
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

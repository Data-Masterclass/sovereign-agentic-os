/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getPillar, updatePillar, deletePillar } from '@/lib/strategy/pillars';
import { rollupForPillar } from '@/lib/strategy/value-rollup';
import { targetsVsActuals } from '@/lib/strategy/snapshots';
import { recentStrategyAudit } from '@/lib/strategy/audit';
import { canEditPillar } from '@/lib/strategy/model';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Pillar detail — the RLS-scoped value roll-up (as seen by THIS caller), the
 * annual+quarterly target-vs-actual view, the audit feed, and the caller's edit
 * capability. The roll-up's per-bet/component values are masked to the caller's
 * entitled domains; the reconcile flag is computed on the full decomposition.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const pillar = await getPillar(user, id);
    const [rollup, progress] = await Promise.all([
      rollupForPillar(pillar, user),
      targetsVsActuals(pillar),
    ]);
    return NextResponse.json({
      pillar,
      rollup,
      progress,
      audit: recentStrategyAudit(id, 25),
      canEdit: canEditPillar(user, pillar),
    });
  } catch (e) {
    return fail(e);
  }
}

/** Edit a pillar's name/description/metric links (Builder domain / Admin tenant). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const item = await updatePillar(user, id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      description: body?.description !== undefined ? String(body.description) : undefined,
      metrics: Array.isArray(body?.metrics) ? body.metrics : undefined,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await deletePillar(user, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

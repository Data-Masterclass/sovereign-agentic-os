/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { buildStage } from '@/lib/data/build/server';

export const dynamic = 'force-dynamic';

/**
 * Build a dashboard on the Cube view (Superset on Trino). Requires at least one
 * defined metric. Runs the Dashboard stage's Build (superset → om) — LIVE if Superset
 * is reachable, else the honest offline-mock — and returns the ✓/✗ rows.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const dataset = getDataset(id, user);
    if (dataset.measures.length === 0) {
      return NextResponse.json({ error: 'define a metric first — a dashboard is built on the Cube view' }, { status: 400 });
    }
    const build = await buildStage(dataset, 'dashboard', user.id);
    return NextResponse.json({ build });
  } catch (e) {
    return errorResponse(e);
  }
}

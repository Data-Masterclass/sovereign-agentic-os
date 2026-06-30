/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { transition } from '@/lib/data/store';
import { stepperStages } from '@/lib/data/panels';

export const dynamic = 'force-dynamic';

/**
 * Reverse lifecycle moves (data-architecture-model.md §Reverse), role-gated +
 * lineage-aware in the store: `decertify` (product→asset) is blocked while domains
 * import it; `unshare` (asset→dataset) is blocked while named individuals are granted.
 */
const REVERSE = new Set(['decertify', 'unshare']);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (!body.action || !REVERSE.has(body.action)) {
      return NextResponse.json({ error: 'action must be decertify or unshare' }, { status: 400 });
    }
    const dataset = transition(id, user, body.action as 'decertify' | 'unshare');
    return NextResponse.json({ dataset, stages: stepperStages(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}

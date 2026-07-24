/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getSystemsUsingDataset, ensureHydrated } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * Agent systems that use THIS dataset — the reverse list the Data tab's Publish stage
 * shows ("agent systems that consume this dataset", each linking to the Agents tab).
 * Read-only over the RLS-scoped system registry, filtered to a per-item data grant.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    await ensureHydrated();
    const { id } = await ctx.params;
    return NextResponse.json({ systems: getSystemsUsingDataset(id, user) });
  } catch (e) {
    return errorResponse(e);
  }
}

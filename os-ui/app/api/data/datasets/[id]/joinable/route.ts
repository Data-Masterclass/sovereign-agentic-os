/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset, listJoinable } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * The Gold join picker's source: the OTHER datasets the caller may REUSE. Identity is
 * from the signed session; {@link listJoinable} is `canView`-scoped, so a non-visible
 * dataset can never appear here. `getDataset(id)` first re-checks the base is viewable.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    getDataset(id, user); // view-scope guard on the base dataset
    return NextResponse.json({ datasets: listJoinable(user, id) });
  } catch (e) {
    return errorResponse(e);
  }
}

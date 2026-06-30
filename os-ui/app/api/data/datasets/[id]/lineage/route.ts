/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { lineageFor } from '@/lib/data/lineage';

export const dynamic = 'force-dynamic';

/** End-to-end lineage (refinement + consumption + trust) + transparency-gate status. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    return NextResponse.json(lineageFor(getDataset(id, user)));
  } catch (e) {
    return errorResponse(e);
  }
}

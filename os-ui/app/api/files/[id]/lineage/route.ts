/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { getFile } from '@/lib/files/store';
import { listLineage } from '@/lib/files/lineage';

export const dynamic = 'force-dynamic';

/** The file's OpenMetadata lineage edges (promoted / certified / derived). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    getFile(id, user); // view-scope guard
    return NextResponse.json({ edges: listLineage(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

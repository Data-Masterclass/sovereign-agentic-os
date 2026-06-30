/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { setDocs } from '@/lib/data/store';
import { transparencyGate } from '@/lib/data/transparency';
import type { ColumnDoc } from '@/lib/data/dataset-schema';

export const dynamic = 'force-dynamic';

/**
 * The documentation form (data-tab-deep-design.md §Trust). Writes the description +
 * column descriptions into dataset.yaml, and returns the live transparency-gate
 * status so the UI can show exactly what is still missing before promotion.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { description?: string; columns?: ColumnDoc[] };
    const dataset = setDocs(id, user, { description: body.description, columns: body.columns });
    return NextResponse.json({ dataset, gate: transparencyGate(dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}

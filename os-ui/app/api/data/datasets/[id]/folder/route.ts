/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { moveDataset } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * Move a dataset into a folder. Runs AS the signed-in user; `moveDataset` is edit-scoped
 * in the store (owner, in-domain domain_admin, or admin), so a viewer is rejected 403 and
 * nothing is written. The move also upserts an explicit folder row in the governed
 * registry, so the destination folder persists even when empty. The Data grid's single-
 * and multi-select "Move to folder…" both hit this route.
 *
 *   POST /api/data/datasets/:id/folder  { folder }  → move the dataset
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { folder?: string };
    if (typeof body.folder !== 'string') {
      return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
    }
    const dataset = moveDataset(id, user, body.folder); // 403 → nothing written
    return NextResponse.json({ dataset });
  } catch (e) {
    return errorResponse(e);
  }
}

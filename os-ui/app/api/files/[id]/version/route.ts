/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { addVersion } from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';

export const dynamic = 'force-dynamic';

/** Re-upload a file → bump its content version (drag-drop versioning). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { text?: string; bytes?: number };
    const asset = addVersion(id, user, { text: body.text, bytes: body.bytes });
    await reindexById(id); // re-index only the changed chunks (content-hash cache)
    return NextResponse.json({ asset });
  } catch (e) {
    return errorResponse(e);
  }
}

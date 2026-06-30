/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { removeSource } from '@/lib/files/connectors';

export const dynamic = 'force-dynamic';

/** Disconnect a source (stops future syncs; already-imported files are kept). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const ok = removeSource(id, user.id);
    if (!ok) return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

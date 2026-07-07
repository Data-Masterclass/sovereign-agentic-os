/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { listFileVersions, restoreFileVersion } from '@/lib/files/store';

export const dynamic = 'force-dynamic';

/**
 * Edit-history snapshots for one file (the generic versionLog, distinct from
 * `[id]/version` which handles drag-drop content re-uploads).
 *   GET          → the snapshot list (newest first; view-scoped).
 *   POST {version} → restore a prior snapshot (edit-scoped; snapshots the
 *                    current state first, so the restore is itself reversible).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const list = listFileVersions(id, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const rec = restoreFileVersion(id, user, body.version);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
  } catch (e) {
    return errorResponse(e);
  }
}

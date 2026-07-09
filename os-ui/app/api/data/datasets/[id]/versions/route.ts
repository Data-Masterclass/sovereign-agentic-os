/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listDatasetVersions, restoreDatasetVersion } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/**
 * Version history for one dataset. Datasets are NOT git-backed (no per-dataset
 * Forgejo repo — the medallion builds live in the store + durable mirror), so this
 * rides the SAME snapshot version log every non-git artifact shares, exposed in the
 * IDENTICAL `{ version, at, author, summary }` shape the ONE VersionHistory panel reads.
 *
 *   GET          → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior definition (edit-scoped; itself snapshots the
 *                    current state first, so the restore is reversible).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const list = listDatasetVersions(id, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list, source: 'snapshot' });
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
    const dataset = restoreDatasetVersion(id, user, body.version);
    return NextResponse.json({ id: dataset.id, tier: dataset.tier, source: 'snapshot' });
  } catch (e) {
    return errorResponse(e);
  }
}

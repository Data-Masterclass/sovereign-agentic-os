/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, listMetricVersions, restoreMetricVersion } from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * Version history for one metric — the OS-wide `{ versions: [...] }` shape the shared
 * <VersionHistory> reads.
 *   GET           → the versions (newest first; edit-scoped).
 *   POST {version} → restore a prior definition (edit-scoped; snapshots current first).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const list = listMetricVersions(id, user).map((v) => ({
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
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const rec = restoreMetricVersion(id, user, body.version);
    return NextResponse.json({ id: rec.id });
  } catch (e) {
    return errorResponse(e);
  }
}

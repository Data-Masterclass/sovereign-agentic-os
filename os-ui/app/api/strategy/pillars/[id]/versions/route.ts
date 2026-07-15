/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { ensureHydrated, listPillarVersions, restorePillarVersion } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Version history for one strategy pillar — the SAME shape every OS artifact
 * exposes ({ versions: [{ version, at, author, summary }] }), so the shared
 * <VersionHistory> panel renders it identically.
 *   GET            → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; snapshots current
 *                    state first, so the restore is itself reversible).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const list = (await listPillarVersions(user, id)).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const item = await restorePillarVersion(user, id, body.version);
    return NextResponse.json({ item });
  } catch (e) {
    return fail(e);
  }
}

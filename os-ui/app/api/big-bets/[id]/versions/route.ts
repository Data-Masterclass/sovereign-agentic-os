/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { ensureHydrated, listBetVersions, restoreBetVersion } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * Version history for one big bet.
 *   GET          → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; itself snapshots the
 *                    current state first, so the restore is reversible).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const list = listBetVersions(id, principal(user)).map((v) => ({
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
    const bet = restoreBetVersion(id, principal(user), body.version);
    return NextResponse.json({ id: bet.id, updatedAt: bet.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

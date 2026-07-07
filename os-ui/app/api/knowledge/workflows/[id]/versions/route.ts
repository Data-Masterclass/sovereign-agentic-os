/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { ensureHydrated, listWorkflowVersions, restoreWorkflowVersion } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * Version history for one knowledge workflow.
 *   GET          → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; itself snapshots the
 *                    current state first, so the restore is reversible).
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await params;
    const list = listWorkflowVersions(id, user).map((v) => ({
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

export async function POST(req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const rec = restoreWorkflowVersion(id, user, body.version);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { transition } from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';
import { listLineage } from '@/lib/files/lineage';
import { pushLineage } from '@/lib/files/catalog';
import type { DataVisibility, Grant, Transition } from '@/lib/data/dataset-schema';

export const dynamic = 'force-dynamic';

const DIRECT: Transition[] = ['certify', 'unshare', 'decertify'];

/**
 * Direct lifecycle moves that are NOT the request/approve promotion path:
 *   • certify   (asset → product) — Admin
 *   • unshare   (asset → dataset) — Builder/Admin
 *   • decertify (product → asset) — Admin
 * The role gate is enforced in the store (REUSED canTransition). Promotion
 * (dataset→asset) goes through /promote (separation of duties).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { transition?: Transition; visibility?: DataVisibility; grants?: Grant[] };
    const t = body.transition;
    if (!t || !DIRECT.includes(t)) {
      return NextResponse.json({ error: `transition must be one of ${DIRECT.join('|')} (promote goes through /promote)` }, { status: 400 });
    }
    const asset = transition(id, user, t, { visibility: body.visibility, grants: body.grants });
    // The tier/grants changed → re-index so the indexed DLS metadata follows.
    await reindexById(id);
    // Best-effort OM catalog mirror of the latest lineage edge (mock-tolerant).
    const latest = listLineage(id)[0];
    if (latest) void pushLineage(latest);
    return NextResponse.json({ asset });
  } catch (e) {
    return errorResponse(e);
  }
}

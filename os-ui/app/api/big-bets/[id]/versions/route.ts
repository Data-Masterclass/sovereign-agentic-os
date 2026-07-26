/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ensureHydrated, listBetVersions, restoreBetVersion } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';

export const dynamic = 'force-dynamic';

/**
 * Version history for one big bet.
 *   GET          → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; itself snapshots the
 *                    current state first, so the restore is reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const list = listBetVersions(id, principal(user)).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
    const { id } = params;
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const bet = restoreBetVersion(id, principal(user), body.version);
    return NextResponse.json({ id: bet.id, updatedAt: bet.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

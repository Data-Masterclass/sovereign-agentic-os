/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listConnectionVersions, restoreConnectionVersion } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Version history for one connection's capability profile — the OS-wide
 * `{ versions: [...] }` shape the shared <VersionHistory> reads.
 *   GET           → the versions (newest first; edit-scoped).
 *   POST {version} → restore a prior profile (edit-scoped; snapshots current first).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const list = (await listConnectionVersions(id, user)).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
}, { defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
    const { id } = params;
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const c = await restoreConnectionVersion(id, user, body.version);
    return NextResponse.json({ id: c.id });
}, { parse: true, defaultStatus: 500 });

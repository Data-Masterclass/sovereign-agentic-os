/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ensureHydrated, listPillarVersions, restorePillarVersion } from '@/lib/strategy/pillars';

export const dynamic = 'force-dynamic';

/**
 * Version history for one strategy pillar — the SAME shape every OS artifact
 * exposes ({ versions: [{ version, at, author, summary }] }), so the shared
 * <VersionHistory> panel renders it identically.
 *   GET            → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; snapshots current
 *                    state first, so the restore is itself reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const list = (await listPillarVersions(user, id)).map((v) => ({
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
  const item = await restorePillarVersion(user, id, body.version);
  return NextResponse.json({ item });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

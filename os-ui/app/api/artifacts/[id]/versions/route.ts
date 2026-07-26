/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listArtifactVersions, restoreArtifactVersion } from '@/lib/core/artifacts';

export const dynamic = 'force-dynamic';

/**
 * Version history for one artifact.
 *   GET           → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; snapshots the current
 *                    state first, so the restore is itself reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const versions = (await listArtifactVersions(id, user)).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));
  return NextResponse.json({ versions });
}, { defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.version !== 'number') {
    return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
  }
  const item = await restoreArtifactVersion(id, user, body.version);
  return NextResponse.json({ item });
}, { parse: true, defaultStatus: 500 });

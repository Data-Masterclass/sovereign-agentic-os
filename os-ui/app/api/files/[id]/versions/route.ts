/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { listFileVersions, restoreFileVersion } from '@tabs/files/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Edit-history snapshots for one file (the generic versionLog, distinct from
 * `[id]/version` which handles drag-drop content re-uploads).
 *   GET          → the snapshot list (newest first; view-scoped).
 *   POST {version} → restore a prior snapshot (edit-scoped; snapshots the
 *                    current state first, so the restore is itself reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const list = listFileVersions(id, user).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));
  return NextResponse.json({ versions: list });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.version !== 'number') {
    return apiError(400, 'A version number is required.', 'files.versionNumberRequired');
  }
  const rec = restoreFileVersion(id, user, body.version);
  return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  ensureHydrated,
  listSystemVersions,
  restoreSystemVersion,
} from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

/**
 * Version history for one agent system — served from the agent STORE's own version
 * log (the snapshot history written on every save/build). There is no git backend:
 * a version is a stored revision of the system record, not a commit.
 *
 *   GET            → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior revision through the store (lineage-safe; the
 *                    restore itself is recorded as a new version, never a rewrite).
 *
 * The `{ version, at, author, summary }` shape + numeric `{ version }` restore
 * contract is unchanged, so the VersionHistory UI is unaffected.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const versions = listSystemVersions(id, user).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));
  return NextResponse.json({ versions });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.version !== 'number') {
    return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
  }
  const rec = restoreSystemVersion(id, user, body.version);
  return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

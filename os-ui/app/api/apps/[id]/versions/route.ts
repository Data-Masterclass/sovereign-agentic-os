/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import {
  ensureHydrated,
  listAppVersions,
  restoreAppVersion,
} from '@tabs/software/lib/apps';

export const dynamic = 'force-dynamic';

/**
 * Version history for one app — served from the app STORE's own version log. An app
 * version is a stored revision of the app record (spec · design · files), not a git
 * commit: the Software tab has no git backend.
 *
 *   GET            → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior revision through the store. The restore is itself
 *                    recorded as a new version — never a destructive rewrite.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const versions = (await listAppVersions(id, user)).map((v) => ({
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
  const app = await restoreAppVersion(id, user, body.version);
  return NextResponse.json({ id: app.id, updatedAt: app.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

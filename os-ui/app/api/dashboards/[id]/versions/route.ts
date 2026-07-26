/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { ensureHydrated, listDashboardVersions, restoreDashboardVersion } from '@/lib/dashboards/store';

export const dynamic = 'force-dynamic';

/**
 * Version history for one dashboard.
 *   GET           → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior spec (owner-scoped; snapshots the current
 *                    spec first, so the restore is itself reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const versions = listDashboardVersions(id, user).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));
  return NextResponse.json({ versions });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.version !== 'number') {
    return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
  }
  return NextResponse.json({ dashboard: restoreDashboardVersion(id, user, body.version) });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal } from '@/lib/data/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { ensureHydrated, listMetricVersions, restoreMetricVersion } from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * Version history for one metric — the OS-wide `{ versions: [...] }` shape the shared
 * <VersionHistory> reads.
 *   GET           → the versions (newest first; edit-scoped).
 *   POST {version} → restore a prior definition (edit-scoped; snapshots current first).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const list = listMetricVersions(id, user).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));
  return NextResponse.json({ versions: list });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.version !== 'number') {
    return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
  }
  const rec = restoreMetricVersion(id, user, body.version);
  return NextResponse.json({ id: rec.id });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });

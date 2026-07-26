/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  ensureHydrated,
  listManualVersions,
  restoreManualVersion,
  type ManualScope,
} from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

const SCOPES: ManualScope[] = ['my', 'domain', 'company'];

function parseScope(raw: string): ManualScope | null {
  return (SCOPES as string[]).includes(raw) ? (raw as ManualScope) : null;
}

/**
 * Version history for one Operating Manual scope — the SAME shape the shared
 * <VersionHistory> reads for every artifact family. The domain scope uses the
 * caller's primary domain (server-resolved), matching the page's read.
 *   GET           → the versions (newest first; view-gated per scope).
 *   POST {version} → restore a prior version (edit-gated per scope; snapshots the
 *                    current card first, so the restore is itself reversible).
 */
export const GET = withRoute<{ scope: string }>(async ({ user, params }) => {
    const scope = parseScope(params.scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const list = listManualVersions(scope, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

export const POST = withRoute<{ scope: string }, { version?: number }>(async ({ user, params, body }) => {
    const scope = parseScope(params.scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const dk = restoreManualVersion(scope, user, body.version);
    return NextResponse.json({ domain: dk.domain, updatedAt: dk.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

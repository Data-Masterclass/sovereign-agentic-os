/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  ensureHydrated,
  listDomainKnowledgeVersions,
  restoreDomainKnowledgeVersion,
} from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

/**
 * Version history for the general DOMAIN-knowledge card (the pinned operating
 * manual) — the SAME shape the shared <VersionHistory> reads for every artifact
 * family. Keyed by domain, since the card is one-per-domain.
 *   GET           → the versions (newest first; view-scoped, in-domain).
 *   POST {version} → restore a prior version (edit-scoped, in-domain; snapshots
 *                    the current card first, so the restore is itself reversible).
 */
export const GET = withRoute<{ domain: string }>(async ({ user, params }) => {
    const { domain } = params;
    const list = listDomainKnowledgeVersions(domain, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

export const POST = withRoute<{ domain: string }, { version?: number }>(async ({ user, params, body }) => {
    const { domain } = params;
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const dk = restoreDomainKnowledgeVersion(domain, user, body.version);
    return NextResponse.json({ domain: dk.domain, updatedAt: dk.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

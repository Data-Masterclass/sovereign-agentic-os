/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import {
  ensureHydrated,
  listDomainKnowledgeVersions,
  restoreDomainKnowledgeVersion,
} from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ domain: string }> };

/**
 * Version history for the general DOMAIN-knowledge card (the pinned operating
 * manual) — the SAME shape the shared <VersionHistory> reads for every artifact
 * family. Keyed by domain, since the card is one-per-domain.
 *   GET           → the versions (newest first; view-scoped, in-domain).
 *   POST {version} → restore a prior version (edit-scoped, in-domain; snapshots
 *                    the current card first, so the restore is itself reversible).
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { domain } = await params;
    const list = listDomainKnowledgeVersions(domain, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { domain } = await params;
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const dk = restoreDomainKnowledgeVersion(domain, user, body.version);
    return NextResponse.json({ domain: dk.domain, updatedAt: dk.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

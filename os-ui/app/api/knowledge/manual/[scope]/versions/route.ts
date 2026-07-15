/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import {
  ensureHydrated,
  listManualVersions,
  restoreManualVersion,
  type ManualScope,
} from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

const SCOPES: ManualScope[] = ['my', 'domain', 'company'];

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

function parseScope(raw: string): ManualScope | null {
  return (SCOPES as string[]).includes(raw) ? (raw as ManualScope) : null;
}

type Params = { params: Promise<{ scope: string }> };

/**
 * Version history for one Operating Manual scope — the SAME shape the shared
 * <VersionHistory> reads for every artifact family. The domain scope uses the
 * caller's primary domain (server-resolved), matching the page's read.
 *   GET           → the versions (newest first; view-gated per scope).
 *   POST {version} → restore a prior version (edit-gated per scope; snapshots the
 *                    current card first, so the restore is itself reversible).
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const scope = parseScope((await params).scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const list = listManualVersions(scope, user).map((v) => ({
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
    const scope = parseScope((await params).scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') {
      return NextResponse.json({ error: 'A version number is required.' }, { status: 400 });
    }
    const dk = restoreManualVersion(scope, user, body.version);
    return NextResponse.json({ domain: dk.domain, updatedAt: dk.updatedAt });
  } catch (e) {
    return fail(e);
  }
}

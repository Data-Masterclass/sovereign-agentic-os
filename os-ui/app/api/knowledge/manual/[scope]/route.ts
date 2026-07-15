/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { ensureHydrated, getManual, updateManual, type ManualScope } from '@/lib/knowledge/store';
import { resolveManual } from '@/lib/knowledge/manual';

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
 * One Operating Manual scope's guided-sections card.
 *   GET  ?domain=<id> → the card + whether the caller may edit it (canEdit).
 *   PATCH { sections } → update section content (edit-gated per scope, server-side).
 * Scopes: my (owner-only) · domain (domain_admin+) · company (admin only).
 */
export async function GET(req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const scope = parseScope((await params).scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const domain = new URL(req.url).searchParams.get('domain') ?? undefined;
    const dk = getManual(scope, user, domain);
    const { canEdit } = resolveManual(scope, user, domain);
    return NextResponse.json({ ...dk, canEdit });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const scope = parseScope((await params).scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const domain = typeof body.domain === 'string' ? body.domain : undefined;
    const dk = updateManual(scope, user, { sections: body.sections }, domain);
    const { canEdit } = resolveManual(scope, user, domain);
    return NextResponse.json({ ...dk, canEdit });
  } catch (e) {
    return fail(e);
  }
}

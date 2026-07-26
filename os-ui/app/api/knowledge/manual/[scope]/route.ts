/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ensureHydrated, getManual, updateManual, type ManualScope } from '@/lib/knowledge/store';
import { resolveManual } from '@/lib/knowledge/manual';

export const dynamic = 'force-dynamic';

const SCOPES: ManualScope[] = ['my', 'domain', 'company'];

function parseScope(raw: string): ManualScope | null {
  return (SCOPES as string[]).includes(raw) ? (raw as ManualScope) : null;
}

/**
 * One Operating Manual scope's guided-sections card.
 *   GET  ?domain=<id> → the card + whether the caller may edit it (canEdit).
 *   PATCH { sections } → update section content (edit-gated per scope, server-side).
 * Scopes: my (owner-only) · domain (domain_admin+) · company (admin only).
 */
export const GET = withRoute<{ scope: string }>(async ({ user, params, req }) => {
    const scope = parseScope(params.scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const domain = new URL(req.url).searchParams.get('domain') ?? undefined;
    const dk = getManual(scope, user, domain);
    const { canEdit } = resolveManual(scope, user, domain);
    return NextResponse.json({ ...dk, canEdit });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<{ scope: string }, any>(async ({ user, params, body }) => {
    const scope = parseScope(params.scope);
    if (!scope) return NextResponse.json({ error: 'Unknown manual scope' }, { status: 404 });
    const domain = typeof body.domain === 'string' ? body.domain : undefined;
    const dk = updateManual(scope, user, { sections: body.sections }, domain);
    const { canEdit } = resolveManual(scope, user, domain);
    return NextResponse.json({ ...dk, canEdit });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

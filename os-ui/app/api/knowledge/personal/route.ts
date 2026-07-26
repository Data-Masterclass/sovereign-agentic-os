/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listPersonalKnowledge, createPersonalKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';

export const dynamic = 'force-dynamic';

/** GET → caller's personal knowledge grouped mine / domain / marketplace. Pass ?archived=1 to include archived. */
export const GET = withRoute(async ({ user, req }) => {
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json(listPersonalKnowledge(user, { includeArchived }));
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** POST → create a personal knowledge entry (a titled markdown note about the user). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<Record<string, string>, any>(async ({ user, body }) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
    const rec = createPersonalKnowledge(user, {
      title,
      md: typeof body.md === 'string' ? body.md : undefined,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
    });
    return NextResponse.json({ id: rec.id, title: rec.title });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });

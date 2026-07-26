/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getDomainKnowledge, updateDomainKnowledge } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

/** GET ?domain=<domain> → the general domain knowledge card. Defaults to the caller's first domain. */
export const GET = withRoute(async ({ user, req }) => {
    const { searchParams } = new URL(req.url);
    const domain = searchParams.get('domain') ?? user.domains[0] ?? 'default';
    return NextResponse.json(getDomainKnowledge(domain));
}, { defaultStatus: 500 });

/** PATCH → update one or more section contents. Body: { domain, sections: [{id, content}] }. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<Record<string, string>, any>(async ({ user, body }) => {
    const domain = typeof body.domain === 'string' ? body.domain : user.domains[0] ?? 'default';
    if (!user.domains.includes(domain)) {
      return NextResponse.json({ error: 'Not permitted to edit knowledge for this domain' }, { status: 403 });
    }
    const dk = updateDomainKnowledge(domain, user, { sections: body.sections });
    return NextResponse.json(dk);
}, { parse: true, defaultStatus: 500 });

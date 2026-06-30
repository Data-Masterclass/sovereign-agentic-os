/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getDomainKnowledge, updateDomainKnowledge } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** GET ?domain=<domain> → the general domain knowledge card. Defaults to the caller's first domain. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const domain = searchParams.get('domain') ?? user.domains[0] ?? 'default';
    return NextResponse.json(getDomainKnowledge(domain));
  } catch (e) {
    return fail(e);
  }
}

/** PATCH → update one or more section contents. Body: { domain, sections: [{id, content}] }. */
export async function PATCH(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const domain = typeof body.domain === 'string' ? body.domain : user.domains[0] ?? 'default';
    if (!user.domains.includes(domain)) {
      return NextResponse.json({ error: 'Not permitted to edit knowledge for this domain' }, { status: 403 });
    }
    const dk = updateDomainKnowledge(domain, user, { sections: body.sections });
    return NextResponse.json(dk);
  } catch (e) {
    return fail(e);
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { currentUser } from '@/lib/core/auth';
import { ACTIVE_DOMAIN_COOKIE, DOMAIN_CHOSEN_COOKIE } from '@/lib/core/active-domain';

export const dynamic = 'force-dynamic';

const YEAR = 60 * 60 * 24 * 365;
const COOKIE = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: YEAR } as const;

/**
 * Set (or clear) the caller's active operating domain.
 *   { domain: "<id>" }  → work in that one domain (lists filter, creates land there)
 *   { domain: null } | { domain: "all" } → back to the cross-domain view
 * Any call also marks the one-time first-login domain prompt as answered.
 *
 * Only a real member domain is accepted — a non-member value is refused, so the
 * cookie can never widen access beyond the signed session.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: { domain?: string | null } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ⇒ clear */
  }
  const requested = body.domain ?? null;

  const store = await cookies();
  store.set(DOMAIN_CHOSEN_COOKIE, '1', COOKIE);

  if (!requested || requested === 'all') {
    store.delete(ACTIVE_DOMAIN_COOKIE);
    return NextResponse.json({ ok: true, activeDomain: null });
  }
  if (!user.allDomains.includes(requested)) {
    return NextResponse.json({ error: 'not a member of that domain' }, { status: 403 });
  }
  store.set(ACTIVE_DOMAIN_COOKIE, requested, COOKIE);
  return NextResponse.json({ ok: true, activeDomain: requested });
}

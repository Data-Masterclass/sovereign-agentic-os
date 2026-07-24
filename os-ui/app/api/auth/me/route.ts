/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { currentUser } from '@/lib/core/auth';
import { getPublicUser } from '@/lib/platform-admin/users';
import { DOMAIN_CHOSEN_COOKIE } from '@/lib/core/active-domain';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user (or null) plus the account flags that drive the first-run
 * gates: `mustChangeCredentials` (force the bootstrap setup) and `onboarded`
 * (show the first-login wizard once). No roster is exposed here — that was a
 * credential-disclosure footgun; the user list is admin-only via /api/users.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ user: null });
  const flags = await getPublicUser(user.id);
  const store = await cookies();
  return NextResponse.json({
    user,
    // Whether the user has ever made an explicit domain choice (incl. "All") —
    // drives the one-time first-login domain prompt for multi-domain users.
    domainChosen: store.get(DOMAIN_CHOSEN_COOKIE)?.value === '1',
    mustChangeCredentials: Boolean(flags?.mustChangeCredentials),
    // Distinguishes the two forced-setup variants: the first-run bootstrap admin
    // (chooses username/email/password) vs. an invited user replacing a temp
    // password (password only). Both share the /onboarding/bootstrap gate.
    bootstrap: Boolean(flags?.bootstrap),
    onboarded: Boolean(flags?.onboarded),
    emailVerified: Boolean(flags?.emailVerified),
    email: flags?.email ?? null,
  });
}

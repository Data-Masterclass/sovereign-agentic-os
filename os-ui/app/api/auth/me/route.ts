/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { currentUser } from '@/lib/core/auth';
import { getPublicUser, knownDomains } from '@/lib/platform-admin/users';
import { ensureHydrated, getDomain, type DomainLayers } from '@/lib/platform-admin/domains';
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
  // The ACTIVE domain's optional-layer flags (layers.ml = Science layer), so the
  // sidebar can hide layer-gated tabs (lib/core/tabs.ts). For a single-domain
  // user with no explicit choice, that one domain IS the active domain. `null`
  // = unknown (multi-domain "All" scope, or domain record not found) — the tab
  // filter FAILS OPEN on null: navigation stays visible and the serving plane
  // 404s honestly if the layer really is off.
  const effectiveDomain = user.activeDomain ?? (user.domains.length === 1 ? user.domains[0] : null);
  let activeDomainLayers: DomainLayers | null = null;
  if (effectiveDomain) {
    try {
      await ensureHydrated(knownDomains);
      activeDomainLayers = getDomain(effectiveDomain).layers ?? null;
    } catch {
      activeDomainLayers = null; // not found / mirror down → unknown → fail open
    }
  }
  return NextResponse.json({
    user: { ...user, activeDomainLayers },
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

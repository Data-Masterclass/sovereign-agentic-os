/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { cookies } from 'next/headers';
import { config } from '@/lib/core/config';
import { SESSION_COOKIE, type Role, verifySession } from '@/lib/core/session';
import { authenticate as authUser, getPublicUser } from '@/lib/platform-admin/users';
import { activeDomainIds } from '@/lib/platform-admin/domains';
import { ACTIVE_DOMAIN_COOKIE, resolveDomainScope } from '@/lib/core/active-domain';

/**
 * Identity facade consumed by the rest of the app. Credentials + the user
 * directory live in `lib/users.ts`; this module turns a request's signed cookie
 * into the `CurrentUser` everything else scopes on. Swap for an Ory adapter
 * later — `currentUser()` / `requireUser()` stay.
 *
 * Note: there is deliberately NO public `roster()` here anymore — exposing the
 * user list (or any credential hint) to the sign-in page was a credential-
 * disclosure footgun. The roster is admin-only via `/api/users`.
 */

export type CurrentUser = {
  id: string;
  name: string;
  /** Effective scope: narrowed to the active operating domain when one is chosen,
   *  else every domain the user belongs to. This is what all lists + create
   *  defaults read, so switching the active domain re-scopes the whole OS. */
  domains: string[];
  /** Every (non-archived) domain the user belongs to — for the switcher + admin
   *  views that legitimately span domains, regardless of the active choice. */
  allDomains: string[];
  /** The chosen active operating domain, or null = all domains. */
  activeDomain: string | null;
  role: Role;
};

export async function authenticate(username: string, password: string) {
  const u = await authUser(username, password);
  if (!u) return null;
  return { id: u.id, name: u.name, domains: u.domains, role: u.role };
}

/** The signed-in user for the current request, or null. Server-only. */
export async function currentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const claims = await verifySession(token, config.sessionSecret);
  if (!claims) return null;
  // Drop archived domains from the live scope (a member no longer sees them even
  // though their JWT still lists them), THEN narrow to the chosen active domain
  // from the sidebar switcher, if any. Narrowing is subset-only — it can never
  // widen access beyond the signed session (see lib/core/active-domain).
  const allDomains = activeDomainIds(claims.domains);
  const requested = store.get(ACTIVE_DOMAIN_COOKIE)?.value ?? null;
  const scope = resolveDomainScope(allDomains, requested);
  return {
    id: claims.id,
    name: claims.name,
    domains: scope.domains,
    allDomains: scope.allDomains,
    activeDomain: scope.activeDomain,
    role: claims.role,
  };
}

/** Guard for API routes. Throws a 401-tagged error if unauthenticated. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) {
    const err = new Error('Not authenticated');
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
  // Server-side enforcement of the forced first-run setup. The bootstrap admin
  // (admin/admin) holds a real admin session, but until it has set a real email
  // + strong password it may NOT touch any protected route — only the setup
  // endpoint (which uses currentUser, not requireUser) and /api/auth/me. This
  // makes the forced credential change a real gate, not just a UI redirect.
  const flags = await getPublicUser(u.id);
  if (flags?.mustChangeCredentials) {
    const err = new Error('Complete first-run setup before using the platform');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return u;
}

/** Guard for admin-only routes. */
export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== 'admin') {
    const err = new Error('Admin only');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return u;
}

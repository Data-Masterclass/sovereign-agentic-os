/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { cookies } from 'next/headers';
import { config } from '@/lib/config';
import { SESSION_COOKIE, type Role, verifySession } from '@/lib/session';
import { authenticate as authUser, getPublicUser } from '@/lib/users';

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
  domains: string[];
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
  return { id: claims.id, name: claims.name, domains: claims.domains, role: claims.role };
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

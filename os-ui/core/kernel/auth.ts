/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { sessionTokenFrom, type Role, verifySession } from '@core/kernel/session';
import { authenticate as authUser, getPublicUser, isReserved } from '@tabs/admin/lib/users';
import { activeDomainIds } from '@tabs/admin/lib/domains';
import { ACTIVE_DOMAIN_COOKIE, resolveDomainScope } from '@core/kernel/active-domain';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { APP_ROUTE_HEADER, APP_ROUTE_SIG_HEADER, openAppRoute } from '@core/kernel/app-route-header';
import { codedError } from '@core/kernel/server-message';

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
  /** Set ONLY when the request authenticated with an app identity token (App Builder D1): the token's audience,
   *  `app:<domain>/<slug>:<env>`. Absent for every session and every other door. */
  via?: string;
};

/**
 * The LIVE principal of a user id — role and domains as they are NOW, not as a session or a
 * stored snapshot remembered them. `null` when the user does not exist or is disabled. The
 * agent engine re-reads a parked run's runner through this before resuming (A2): a runner who
 * was deactivated or lost the role since the run parked must not have the run execute as them.
 */
/**
 * A member's domains as they are in scope NOW: archived domains dropped, the same narrowing the
 * cookie session applies. For the headless doors (MCP bearer, scheduled runs, alert evaluation),
 * which resolve a stored user id rather than a signed session.
 */
export function liveDomains(ids: string[]): string[] {
  return activeDomainIds(ids);
}

export async function principalById(id: string): Promise<{ id: string; name: string; role: Role; domains: string[] } | null> {
  const u = await getPublicUser(id);
  if (!u || u.disabled) return null;
  return { id: u.id, name: u.name, role: u.role, domains: activeDomainIds(u.domains) };
}

export async function authenticate(username: string, password: string) {
  const u = await authUser(username, password);
  if (!u) return null;
  return { id: u.id, name: u.name, domains: u.domains, role: u.role };
}

/** The signed-in user for the current request, or null. Server-only. */
export async function currentUser(): Promise<CurrentUser | null> {
  // Imported lazily, not at module top: `next/headers` is a request-bound API that only
  // exists inside a Next.js request, and the run worker (`worker/agent-runs.ts`) imports this
  // module for `CurrentUser`/`authenticate` without ever having a request. The standalone
  // image does not even ship `next/headers.js`, so a static import would fail at worker boot.
  const { cookies, headers } = await import('next/headers');
  // APP IDENTITY TOKEN (App Builder D1, workstream E): only while the App Builder is on, only an
  // `Authorization: Bearer` whose header says `typ: os-app+jwt`, and only on the SDK route allowlist
  // (core/auth/app-token.ts APP_TOKEN_ROUTES; the route arrives in the header the edge middleware deletes from
  // every request and sets, sealed, only for /api/*). Such a request is decided by the token ALONE: a refusal is "not signed in", never a fall-back
  // to a cookie. With the switch off this block is skipped entirely.
  if (appBuilderEnabled()) {
    const h = await headers();
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(h.get('authorization') ?? '')?.[1];
    if (bearer) {
      const { looksLikeAppToken } = await import('@core/auth/app-token');
      if (looksLikeAppToken(bearer)) return appBearerUser(bearer, h.get(APP_ROUTE_HEADER), h.get(APP_ROUTE_SIG_HEADER));
    }
  }
  const store = await cookies();
  // Only the `__Host-` session cookie counts; a tossed legacy `soa_session` is ignored.
  const token = sessionTokenFrom((n) => store.get(n)?.value);
  const claims = await verifySession(token, config.sessionSecret);
  if (!claims) return null;
  // Who the user is NOW is the user directory's answer, not the snapshot the cookie was signed
  // with at login (up to 12 h ago):
  //   - deactivated → no session (the cookie alone must not keep a deactivated user in);
  //   - no record → no session (a deleted user), EXCEPT a reserved principal, which never has a
  //     public record: that one keeps the signed session's scope, nothing widened;
  //   - role and domains are the directory's, so a demotion, a new domain and a removed
  //     membership all take effect at once (a domain created and joined after sign-in reaches
  //     the sidebar dropdown without signing in again).
  // A directory that fails to read fails the request, exactly as `requireUser`'s own directory
  // read does — never a silent guess.
  const live = await getPublicUser(claims.id);
  if (live?.disabled) return null;
  if (!live && !isReserved(claims.id)) return null;
  const memberOf = live && Array.isArray(live.domains) ? live.domains : claims.domains;
  // Drop archived domains from the live scope (a member no longer sees them), THEN narrow to the
  // chosen active domain from the sidebar switcher, if any. Narrowing is subset-only — the
  // active-domain cookie can never widen access beyond the membership (see core/kernel/active-domain).
  const allDomains = activeDomainIds(memberOf);
  const requested = store.get(ACTIVE_DOMAIN_COOKIE)?.value ?? null;
  const scope = resolveDomainScope(allDomains, requested);
  return {
    id: claims.id,
    name: claims.name,
    domains: scope.domains,
    allDomains: scope.allDomains,
    activeDomain: scope.activeDomain,
    role: live?.role ?? claims.role,
  };
}

/**
 * The user an app identity token acts for, on THIS route, or null. Role and domains are the user record's NOW (a
 * demoted or deactivated user loses access with a still-valid token); the app, its grants, the user's consent and
 * the route are all re-checked (core/auth/app-identity.ts `acceptAppBearer`). No active-domain narrowing: an app
 * call has no domain switcher. The refusal reason is not logged with any token material.
 */
async function appBearerUser(token: string, route: string | null, sig: string | null): Promise<CurrentUser | null> {
  // Only an /api/ route the edge middleware sealed for THIS request (core/kernel/app-route-header.ts): a client-sent
  // header, a page, /oauth/*, /tools/* or a path the middleware never saw is "not signed in" for an app token.
  const real = await openAppRoute(route, sig, config.sessionSecret);
  if (!real) return null;
  const { acceptAppBearer } = await import('@core/auth/app-identity');
  const r = await acceptAppBearer(token, real.method, real.pathname);
  if (!r.ok) return null; // refused token: "not signed in" on this route, never a fall-back to a cookie
  const { principal, via } = r.accepted;
  return { id: principal.id, name: principal.name, domains: principal.domains, allDomains: principal.domains, activeDomain: null, role: principal.role as Role, via };
}

/** Guard for API routes. Throws a 401-tagged error if unauthenticated. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) {
    throw codedError(401, 'Not authenticated', 'auth.notAuthenticated');
  }
  // Server-side enforcement of the forced first-run setup. The bootstrap admin
  // (admin/admin) holds a real admin session, but until it has set a real email
  // + strong password it may NOT touch any protected route — only the setup
  // endpoint (which uses currentUser, not requireUser) and /api/auth/me. This
  // makes the forced credential change a real gate, not just a UI redirect.
  const flags = await getPublicUser(u.id);
  if (flags?.mustChangeCredentials) {
    throw codedError(403, 'Complete first-run setup before using the platform', 'auth.setupRequired');
  }
  return u;
}

/** Guard for admin-only routes. */
export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== 'admin') {
    throw codedError(403, 'Admin only', 'auth.adminOnly');
  }
  return u;
}

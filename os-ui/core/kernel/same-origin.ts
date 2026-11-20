/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Same-origin enforcement for cookie-authenticated OS API requests
 * USER STORY:   As a signed-in user, a page on another origin (a deployed app, a look-alike site) must not be able to act on the OS as me.
 * ARCHITECTURE: Pure, edge-safe verdict function called by middleware.ts before any /api/ route runs.
 */
/**
 * Same-origin enforcement for the OS API (edge-safe, no Node APIs).
 *
 * The OS UI is the only browser origin that may use the OS session cookie against
 * `/api/`. A cookie-authenticated request must therefore PROVE it comes from the OS's
 * own origin before a state-changing method (POST/PUT/PATCH/DELETE) runs — and, for
 * the admin surfaces, before a read runs too. The proof, in order (Fetch Metadata and
 * Origin are both standard, browser-set, and not settable by page script):
 *
 *   1. `Sec-Fetch-Site: same-origin` → allowed. Any other Sec-Fetch-Site value except
 *      `none` (a user-typed navigation, GET only) is refused outright.
 *   2. `Origin` present → it must EXACTLY equal an OS origin (scheme + host + port).
 *   3. No Origin → the `Referer`'s origin must equal an OS origin.
 *   4. Neither → refused (a cookie-carrying browser request with no provenance).
 *
 * "An OS origin" is `OS_PUBLIC_URL`'s origin, or this request's own origin (Host +
 * forwarded scheme) — the textbook same-origin comparison, which also covers an
 * in-cluster client calling the service by its internal name.
 *
 * Requests WITHOUT the session cookie are not checked: bearer-token API/MCP clients,
 * OAuth token exchanges and server-to-server webhooks never rely on ambient browser
 * credentials, so there is nothing to forge. A request that carries an
 * `Authorization` header is likewise not checked: a cross-origin page can only add
 * that header after a CORS preflight, which the OS answers for its own origin only.
 */

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** API prefixes where even a read requires same-origin provenance. */
export const ADMIN_API_PREFIXES: readonly string[] = ['/api/platform-admin/', '/api/admin/'];

/** The canonical origin (`scheme://host[:port]`) of a URL, or '' when unparseable. */
export function originOf(url: string | null | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  // Not a URL → no origin (the caller treats '' as "matches nothing", i.e. refuse).
  if (!URL.canParse(raw)) return '';
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  return u.origin.toLowerCase();
}

function isAdminPath(pathname: string): boolean {
  return ADMIN_API_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
}

/** Does this request need same-origin provenance at all? */
export function needsSameOriginCheck(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  const m = method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(m)) return true;
  // Admin reads too (OPTIONS preflights are answered by CORS, never reach a handler).
  return (m === 'GET' || m === 'HEAD') && isAdminPath(pathname);
}

export type SameOriginInput = {
  method: string;
  pathname: string;
  /** Request headers (only origin / referer / sec-fetch-site / authorization are read). */
  headers: Headers;
  /** True when the request carries the OS session cookie. */
  hasSessionCookie: boolean;
  /** `OS_PUBLIC_URL` (may be empty in local dev). */
  osPublicUrl: string | undefined;
  /** This request's own origin as seen by the server (Host + forwarded scheme). */
  requestOrigin: string | undefined;
};

export type SameOriginVerdict = { ok: true } | { ok: false; reason: string };

/** Decide whether a request may proceed. Pure; see the module doc for the rules. */
export function checkSameOrigin(input: SameOriginInput): SameOriginVerdict {
  if (!needsSameOriginCheck(input.method, input.pathname)) return { ok: true };
  if (!input.hasSessionCookie) return { ok: true };
  if ((input.headers.get('authorization') ?? '').trim()) return { ok: true };

  const allowed = new Set([originOf(input.osPublicUrl), originOf(input.requestOrigin)].filter(Boolean));

  const site = (input.headers.get('sec-fetch-site') ?? '').trim().toLowerCase();
  if (site === 'same-origin') return { ok: true };
  if (site === 'none') {
    // A user-initiated top-level navigation (address bar / bookmark). Never a write.
    const m = input.method.toUpperCase();
    return m === 'GET' || m === 'HEAD'
      ? { ok: true }
      : { ok: false, reason: 'cross-origin request refused' };
  }
  if (site) return { ok: false, reason: 'cross-origin request refused' };

  const origin = input.headers.get('origin');
  if (origin !== null) {
    return allowed.has(originOf(origin)) ? { ok: true } : { ok: false, reason: 'cross-origin request refused' };
  }
  const referer = input.headers.get('referer');
  if (referer) {
    return allowed.has(originOf(referer)) ? { ok: true } : { ok: false, reason: 'cross-origin request refused' };
  }
  return { ok: false, reason: 'request origin missing' };
}

/** The request's own origin from forwarded headers (ingress) or the URL itself. */
export function requestOriginOf(url: URL, headers: Headers): string {
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0].trim();
  const proto = (headers.get('x-forwarded-proto') ?? '').split(',')[0].trim() || url.protocol.replace(/:$/, '');
  if (!host) return url.origin;
  return `${proto}://${host}`;
}

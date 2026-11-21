/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Same-origin enforcement for cookie-authenticated OS API requests
 * USER STORY:   As a signed-in user, a page on another origin (a deployed app, a look-alike site) must not be able to act on the OS as me.
 * ARCHITECTURE: Pure, edge-safe verdict function called by middleware.ts before any /api/ route runs.
 */
/**
 * Same-origin enforcement for the OS API and the tool proxy (edge-safe, no Node APIs).
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
 * "An OS origin" comes from CONFIGURATION only: `OS_PUBLIC_URL` plus the hosts listed in
 * `OS_PUBLIC_URL_ALIASES` (the other OS UI ingress host, rendered by the chart). Request
 * data such as `Host` or `X-Forwarded-Host` never widens that set. Only when no public
 * URL is configured at all (local dev) is the request URL's own origin used.
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

/**
 * State-changing (or credential-minting) GET routes outside the admin prefixes.
 * Each is checked like a write (audit for the same-origin PR):
 *   - /api/metrics/alerts/run        evaluates every alert rule and records the result
 *   - /api/mcp/token                 mints a bearer token for the signed-in user
 *   - /api/connections/oauth/<p>/authorize, /api/connections/notion/authorize
 *                                     start an OAuth flow (register a client, store PKCE state)
 * Deliberately NOT checked (cross-site by design, each protected by its own secret):
 *   OAuth callbacks (state + PKCE), /api/auth/verify (single-use e-mail token).
 */
export const STATE_CHANGING_GET_PATTERNS: readonly RegExp[] = [
  /^\/api\/metrics\/alerts\/run\/?$/,
  /^\/api\/mcp\/token\/?$/,
  /^\/api\/connections\/oauth\/[^/]+\/authorize\/?$/,
  /^\/api\/connections\/notion\/authorize\/?$/,
];

/**
 * The path the check reasons about: lower-cased, `%2F` / `%5C` / backslashes turned
 * into `/`, and repeated slashes collapsed, so `/API/…`, `/api//platform-admin` and
 * `/api/platform-admin%2Fsettings` are judged as the admin path they look like. (The
 * router itself is case-sensitive and does not split on `%2F`, so those spellings 404
 * there; this keeps the check from depending on that.)
 */
export function canonicalApiPath(pathname: string): string {
  return pathname
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function isAdminPath(path: string): boolean {
  return ADMIN_API_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/** Does this request need same-origin provenance at all? */
export function needsSameOriginCheck(method: string, pathname: string): boolean {
  const path = canonicalApiPath(pathname);
  const m = method.toUpperCase();
  // Writes through the same-origin tool proxy are covered too.
  if (path.startsWith('/tools/')) return STATE_CHANGING_METHODS.has(m);
  // The MCP consent decision (outside /api/): approving issues an authorization code.
  if (/^\/oauth\/authorize\/?$/.test(path)) return STATE_CHANGING_METHODS.has(m);
  if (!path.startsWith('/api/')) return false;
  if (STATE_CHANGING_METHODS.has(m)) return true;
  // Admin reads + the audited state-changing GETs (OPTIONS preflights never reach here).
  return (m === 'GET' || m === 'HEAD') && (isAdminPath(path) || STATE_CHANGING_GET_PATTERNS.some((r) => r.test(path)));
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
  /** Further configured OS UI origins (`OS_PUBLIC_URL_ALIASES`). */
  osPublicUrlAliases: readonly string[];
  /** The request URL's own origin — consulted ONLY when no public URL is configured. */
  requestOrigin: string | undefined;
};

export type SameOriginVerdict = { ok: true } | { ok: false; reason: string };

/** Decide whether a request may proceed. Pure; see the module doc for the rules. */
export function checkSameOrigin(input: SameOriginInput): SameOriginVerdict {
  if (!needsSameOriginCheck(input.method, input.pathname)) return { ok: true };
  if (!input.hasSessionCookie) return { ok: true };
  if ((input.headers.get('authorization') ?? '').trim()) return { ok: true };

  const configured = [originOf(input.osPublicUrl), ...input.osPublicUrlAliases.map(originOf)].filter(Boolean);
  const allowed = new Set(configured.length > 0 ? configured : [originOf(input.requestOrigin)].filter(Boolean));

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

/**
 * The request URL's own origin. Forwarded headers are deliberately NOT read: they are
 * request data, and the allowed origins come from configuration.
 */
export function requestOriginOf(url: URL, _headers?: Headers): string {
  return url.origin;
}

/** A comma-separated list of origins (`OS_PUBLIC_URL_ALIASES`), canonicalised; junk dropped. */
export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((x) => originOf(x))
    .filter(Boolean);
}

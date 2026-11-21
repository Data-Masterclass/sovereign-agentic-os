/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Stateless signed-session helper. Edge-safe (Web Crypto only) so it can run in
 * both Next.js middleware (Edge runtime) and Node route handlers. The session is
 * a compact, HMAC-SHA256-signed token: `base64url(payload).base64url(signature)`.
 *
 * This is the seam Ory will replace later: swap `signSession`/`verifySession`
 * for Kratos session validation and the rest of the app keeps working, because
 * everything downstream only ever sees the `SessionClaims` shape.
 */

/**
 * Domain role, lowest→highest privilege:
 *  - `creator` (0): Base role — create + run own data/agents/apps, consume shared.
 *    Cannot promote to Shared, approve, or reach admin. Files promotion requests.
 *  - `builder` (1): Domain approver — creator rights plus review/approve domain
 *    promotions, deploys, knowledge and connections. An approver, NOT a
 *    people-admin.
 *  - `domain_admin` (2): Builder rights plus administering users in their OWN
 *    domain(s) only (invite/edit/deactivate, assign roles up to builder — never
 *    domain_admin or admin) and all domain-scoped governance approvals. No
 *    tenant/platform powers.
 *  - `admin` (3): Platform admin — tenant-wide control: users, policy,
 *    certification, cost caps, role matrix. The ONLY role that can assign
 *    `domain_admin`.
 * (Governance golden path §5.) Former `participant` and `agentic-leader` roles are
 * removed; any legacy/unknown role normalises to `creator`.
 */
import { b64urlDecode, b64urlEncode } from '@core/kernel/base64url';

export type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';

/** Every role, lowest→highest privilege. Single source for selects + ranking. */
export const ROLES: readonly Role[] = ['creator', 'builder', 'domain_admin', 'admin'] as const;

/** True when `role` ranks at or above `min` (creator<builder<domain_admin<admin).
 * Edge-safe + dependency-free — the ONE floor check every gate can share. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

export type SessionClaims = {
  /** Stable user id (login handle). */
  id: string;
  /** Display name. */
  name: string;
  /** Every domain (tenant scope) this user belongs to. */
  domains: string[];
  role: Role;
  /** Issued-at (epoch seconds). */
  iat: number;
};

/** Promote gate: APPROVING Personal→Shared needs a domain_admin+, Shared→Certified
 * needs an admin. (Filing a promotion REQUEST is open to any creator/builder — that
 * request path is gated separately; this is the APPROVER authority.) */
export function canPromote(role: Role, from: 'Personal' | 'Shared'): boolean {
  if (from === 'Personal') return roleAtLeast(role, 'domain_admin');
  return role === 'admin';
}

/**
 * The OS session cookie. The `__Host-` prefix makes the BROWSER enforce Secure,
 * Path=/ and no Domain (RFC 6265bis §4.1.3.2): a cookie of this name can only ever
 * have been set by the OS host itself, so a sibling or child host (a deployed app)
 * cannot plant ("toss") one that the OS would read.
 */
export const SESSION_COOKIE = '__Host-soa_session';
/**
 * The name used ONLY when the operator opts out of `Secure` for plain-http local dev
 * (OS_SESSION_COOKIE_INSECURE=true / non-production): a `__Host-` cookie without
 * Secure is rejected by the browser, so it cannot carry the prefix.
 */
export const INSECURE_SESSION_COOKIE = 'soa_session_insecure';
/** The pre-0.9.23 name. Never read; expired wherever the OS sees it. */
export const LEGACY_SESSION_COOKIE = 'soa_session';
/** Every name the OS session has ever used — for stripping before a proxy hop. */
export const ALL_SESSION_COOKIE_NAMES: readonly string[] = [SESSION_COOKIE, INSECURE_SESSION_COOKIE, LEGACY_SESSION_COOKIE];

/** The cookie name this deployment WRITES and READS (one name, decided by `Secure`). */
export function sessionCookieName(isProd?: boolean): string {
  return secureByDefault(isProd) ? SESSION_COOKIE : INSECURE_SESSION_COOKIE;
}

/**
 * The session token from a request's cookies — read from `sessionCookieName()` ONLY.
 * A legacy `soa_session` (which any parent-domain host could have set) is ignored.
 */
export function sessionTokenFrom(
  get: (name: string) => string | undefined,
  isProd?: boolean,
): string | undefined {
  return get(sessionCookieName(isProd)) || undefined;
}
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

/**
 * The parent `Domain` that releases up to 0.9.x scoped the session cookie to (the
 * longest common ≥2-label suffix of the OS host and the apps domain). The OS no
 * longer sets it — the session cookie is HOST-ONLY — but browsers may still hold a
 * cookie set on that Domain, so login / bootstrap / logout EXPIRE it there too.
 * Returns null when no such Domain was ever derivable (local dev, unrelated domains).
 */
export function legacySessionCookieDomain(
  osPublicUrl: string | undefined,
  appsDomain: string | undefined,
): string | null {
  const osHost = hostOf(osPublicUrl);
  const apps = (appsDomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!osHost || !apps) return null;
  if (osHost === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(osHost)) return null;
  const parent = longestCommonDomainSuffix(osHost, apps);
  if (!parent || parent.split('.').length < 2) return null;
  return `.${parent}`;
}

function hostOf(url: string | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // Bare host (no scheme) — accept it as-is.
    return raw.toLowerCase().replace(/\/.*$/, '');
  }
}

/** The longest shared dotted suffix of two hostnames (label-aligned). */
function longestCommonDomainSuffix(a: string, b: string): string {
  const al = a.split('.');
  const bl = b.split('.');
  const out: string[] = [];
  let i = al.length - 1;
  let j = bl.length - 1;
  while (i >= 0 && j >= 0 && al[i] === bl[j]) {
    out.unshift(al[i]);
    i--;
    j--;
  }
  return out.join('.');
}

function secureByDefault(isProd: boolean | undefined): boolean {
  // OS_SESSION_COOKIE_INSECURE=true drops `Secure` for plain-http local dev
  // (the Docker Compose stack): Safari rejects Secure cookies on http://localhost.
  return (
    isProd ??
    (process.env.NODE_ENV === 'production' && process.env.OS_SESSION_COOKIE_INSECURE !== 'true')
  );
}

/**
 * The canonical session-cookie options. ONE place so login / bootstrap / logout
 * agree. The cookie is HOST-ONLY (no `Domain` attribute), `HttpOnly`, `SameSite=Lax`
 * and `Secure` in production, so the browser sends it to the OS host and nowhere
 * else — never to the apps domain or any other subdomain.
 */
export function sessionCookieOptions(opts: { maxAge?: number; isProd?: boolean } = {}): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureByDefault(opts.isProd),
    path: '/',
    maxAge: opts.maxAge ?? MAX_AGE_SECONDS,
  };
}

/**
 * `Set-Cookie` values that expire every session cookie an older release could have
 * left behind: the legacy `soa_session` host-only, and on the legacy parent Domain
 * (when one was derivable). Append each as its own header next to the live cookie.
 */
export function legacySessionCookieExpiries(opts: {
  osPublicUrl?: string;
  appsDomain?: string;
  isProd?: boolean;
}): string[] {
  const secure = secureByDefault(opts.isProd) ? '; Secure' : '';
  const base = `${LEGACY_SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`;
  const out = [base];
  const domain = legacySessionCookieDomain(opts.osPublicUrl, opts.appsDomain);
  if (domain) out.push(base.replace('; Path=/', `; Domain=${domain}; Path=/`));
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();


async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign a session payload (iat is stamped here). Returns the cookie value. */
export async function signSession(
  claims: Omit<SessionClaims, 'iat'>,
  secret: string,
): Promise<string> {
  const payload: SessionClaims = { ...claims, iat: Math.floor(Date.now() / 1000) };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

/** Verify + decode a cookie value. Returns null on any tamper / expiry. */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
): Promise<SessionClaims | null> {
  if (!token || !token.includes('.')) return null;
  const [body, sigPart] = token.split('.');
  if (!body || !sigPart) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigPart),
      enc.encode(body),
    );
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(b64urlDecode(body))) as SessionClaims;
    if (!claims?.id || !Array.isArray(claims?.domains) || !claims?.role) return null;
    if (Math.floor(Date.now() / 1000) - claims.iat > MAX_AGE_SECONDS) return null;
    return claims;
  } catch {
    return null;
  }
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS;

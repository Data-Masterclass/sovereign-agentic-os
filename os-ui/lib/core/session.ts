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

export const SESSION_COOKIE = 'soa_session';
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

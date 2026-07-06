/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * CSRF-hardened OAuth `state` — a compact HMAC-SHA256-signed token, same shape as
 * the session cookie (`base64url(payload).base64url(sig)`), Web-Crypto only so it
 * runs in any runtime. Double-submit defence:
 *
 *   1. The signed state carries {connectionId, userId, provider, nonce, iat}. A
 *      tampered payload fails the signature check.
 *   2. The SAME nonce is also set in an httpOnly cookie at authorize time; the
 *      callback requires cookie.nonce === state.nonce. An attacker who forges a
 *      callback cannot also set our signed cookie, so a cross-site callback is
 *      rejected even if it replays a stolen state.
 *   3. `iat` bounds the flow to a short TTL (default 10 min).
 *
 * The secret is the session secret (server-only). Nothing here is ever logged.
 */

export type OAuthState = {
  connectionId: string;
  userId: string;
  provider: string;
  nonce: string;
  /** issued-at, epoch seconds */
  iat: number;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const DEFAULT_TTL_SECONDS = 60 * 10; // 10 minutes

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
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** A fresh random nonce (also set as the double-submit cookie). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64urlEncode(b);
}

/** Sign an OAuth state token. `iat` is stamped here. */
export async function signState(
  input: Omit<OAuthState, 'iat'>,
  secret: string,
): Promise<string> {
  const payload: OAuthState = { ...input, iat: Math.floor(Date.now() / 1000) };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

/**
 * Verify + decode a state token. Returns null on ANY tamper, bad signature, or
 * expiry. Does NOT check the cookie nonce — the caller compares
 * `state.nonce === cookieNonce` (double-submit) after this returns.
 */
export async function verifyState(
  token: string | undefined | null,
  secret: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<OAuthState | null> {
  if (!token || !token.includes('.')) return null;
  const [body, sigPart] = token.split('.');
  if (!body || !sigPart) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigPart), enc.encode(body));
    if (!ok) return null;
    const s = JSON.parse(dec.decode(b64urlDecode(body))) as OAuthState;
    if (!s?.connectionId || !s?.userId || !s?.provider || !s?.nonce || typeof s?.iat !== 'number') return null;
    if (Math.floor(Date.now() / 1000) - s.iat > ttlSeconds) return null;
    return s;
  } catch {
    return null;
  }
}

/** Constant-time-ish nonce equality (double-submit check). */
export function nonceMatches(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const OAUTH_STATE_COOKIE = 'soa_oauth_nonce';

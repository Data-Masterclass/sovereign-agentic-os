/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OAuth `state` — a signed, short-lived CSRF token for the connection flows
 * USER STORY: As a user connecting a drive or Notion I want the callback to accept only the flow
 *             I started so that a forged callback cannot attach someone else's account.
 * ARCHITECTURE:
 *   - HMAC-SHA256 signed `base64url(payload).base64url(sig)`, same shape as the session cookie;
 *     Web Crypto only. The key is the server-side session secret.
 *   - Double submit: the same nonce is set in an httpOnly cookie, and the callback checks
 *     `nonceMatches(cookie, state.nonce)` after `verifyState`.
 *   - `iat` limits a flow to a TTL (default 10 minutes). Used by the drive and Notion routes.
 */

import { b64urlDecode, b64urlEncode } from '@core/kernel/base64url';

export type OAuthState = {
  connectionId: string;
  userId: string;
  provider: string;
  nonce: string;
  /** Where to land after the callback (an OS path, checked by `safeReturnTo`). Optional. */
  returnTo?: string;
  /** issued-at, epoch seconds */
  iat: number;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const DEFAULT_TTL_SECONDS = 60 * 10; // 10 minutes


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

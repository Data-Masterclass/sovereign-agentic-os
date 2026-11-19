/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    base64url (RFC 4648 §5, no padding) — the one encoder for tokens, JWTs and PKCE
 * USER STORY: As a maintainer I want one tested base64url implementation, not five private
 *             copies (session cookie, OAuth state, PKCE, GCP JWT, Snowflake JWT) that could
 *             drift apart on padding or alphabet.
 * ARCHITECTURE:
 *   - PURE and runtime-neutral: `btoa`/`atob` only, no `Buffer` and no `node:` import, so the
 *     Edge middleware (`core/kernel/session.ts`) can use it as well as Node routes.
 *   - `base64url(Buffer | string)` keeps the call shape the JOSE signers already used; a string
 *     is UTF-8 encoded first, exactly like `Buffer.from(s, 'utf8')`.
 */

/** Bytes → base64url, no `=` padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (padded or not) → bytes. */
export function b64urlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** base64url of a byte buffer or a UTF-8 string (no padding) — the JOSE encoding. */
export function base64url(input: Uint8Array | string): string {
  return b64urlEncode(typeof input === 'string' ? new TextEncoder().encode(input) : input);
}

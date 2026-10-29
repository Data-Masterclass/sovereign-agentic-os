/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PKCE (RFC 7636) — the code verifier + S256 challenge for the Notion hosted-MCP
 * OAuth flow. PURE Web-Crypto: no secrets vault, no `server-only`, no network, so
 * it runs in any runtime and unit-tests directly.
 *
 * Notion's hosted MCP registers us as a PUBLIC OAuth client (no client secret), so
 * PKCE is the mechanism that binds the authorization code to the exact browser
 * session that started the flow: only the holder of the verifier can redeem the
 * code. The verifier is high-entropy and NEVER leaves the server (it is held in a
 * short-lived server-side flow store, not in the URL or any client response).
 */

export type PkcePair = { verifier: string; challenge: string; method: 'S256' };

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh, RFC-length (43+ char) high-entropy code verifier. */
export function randomVerifier(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** The S256 challenge = base64url(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return b64url(digest);
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  return { verifier, challenge, method: 'S256' };
}

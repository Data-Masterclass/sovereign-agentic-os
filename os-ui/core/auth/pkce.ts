/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    PKCE (RFC 7636) — code verifier and S256 challenge for the Notion MCP OAuth flow
 * USER STORY: As a user connecting Notion I want the authorization code bound to the session that
 *             started the flow so that only that session can redeem it.
 * ARCHITECTURE:
 *   - Pure Web Crypto: no vault, no `server-only`, no network, so it runs in any runtime.
 *   - Needed because Notion registers the OS as a public client with no client secret.
 *   - Called by the Notion authorize route; the verifier is kept in `notion-flow.ts`, never in a URL.
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

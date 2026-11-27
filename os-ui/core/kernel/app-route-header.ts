/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    App Builder (E) - the request route the edge middleware hands to the kernel, sealed so nobody else can
 * USER STORY: As the OS owner I want an app token to work ONLY on the allowlisted API routes, and the route the kernel
 *             checks to be the real one of this request, never a value a client typed into a header.
 * ARCHITECTURE:
 *   - A Next.js route handler cannot see its own path, so the edge middleware (os-ui/middleware.ts) tells the kernel:
 *     `x-os-app-route: <METHOD> <pathname>` plus `x-os-app-route-sig`, an HMAC-SHA256 over that value with a key
 *     derived from the session secret (which the middleware already holds to verify sessions). The middleware deletes
 *     both headers from EVERY request first and sets them only for /api/* while the App Builder is on.
 *   - The kernel (core/kernel/auth.ts) accepts an app token only when the value is an /api/ route AND the seal
 *     verifies, so a client value cannot pass even on a path the middleware matcher skips.
 *   - Web Crypto only and import-free: it is in the Edge middleware's import graph (middleware-edge-safe.test.ts).
 */

export const APP_ROUTE_HEADER = 'x-os-app-route';
export const APP_ROUTE_SIG_HEADER = 'x-os-app-route-sig';
const LABEL = 'os-app-route-v1:';

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(LABEL + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** The seal of a route value (`<METHOD> <pathname>`). */
export async function sealAppRoute(value: string, secret: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(value)));
}

/**
 * The route the middleware sealed for this request, or null: the value must be `<METHOD> /api/...`, the seal must
 * verify (constant-time compare) and the secret must be non-empty.
 */
export async function openAppRoute(value: string | null, sig: string | null, secret: string): Promise<{ method: string; pathname: string } | null> {
  if (!value || !sig || !secret) return null;
  const m = /^([A-Z]{3,7}) (\/api\/\S*)$/.exec(value);
  if (!m) return null;
  const want = await sealAppRoute(value, secret);
  if (want.length !== sig.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0 ? { method: m[1], pathname: m[2] } : null;
}

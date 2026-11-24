/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OAuth redirect URI — the public base URL and the callback URI for each provider
 * USER STORY: As a platform admin I want one exact callback URI to register on the provider app so
 *             that the authorize step and the token exchange always match.
 * ARCHITECTURE:
 *   - Pure helpers used by the drive and Notion authorize and callback routes.
 *   - Prefers `OS_PUBLIC_URL`; falls back to the request origin for local development.
 */
export function publicBaseUrl(reqUrl: string): string {
  const env = (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (env) return env;
  try {
    return new URL(reqUrl).origin;
  } catch {
    return '';
  }
}

/** The exact callback redirect URI for a provider (register this in the console). */
export function callbackUri(base: string, provider: string): string {
  return `${base.replace(/\/+$/, '')}/api/connections/oauth/${provider}/callback`;
}

/**
 * Where to send an OAuth START that arrived on a host other than the canonical one
 * (`OS_PUBLIC_URL`), or null when it already is canonical (or no canonical URL is configured).
 *
 * Why: the authorize step sets the CSRF nonce cookie host-only on the host it answers from,
 * while the provider returns the user to the canonical callback. Started on an alias
 * (os.<zone> beside the apex), the callback never sees the cookie and fails `invalid_state`.
 * Moving the start to the canonical origin first keeps cookie and callback on ONE origin,
 * without widening the cookie's domain. The target is built from `OS_PUBLIC_URL` only, never
 * from the request's Host header, so it cannot be pointed elsewhere.
 */
export function canonicalStartUrl(reqUrl: string, requestHost: string | null): string | null {
  const env = (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!env) return null;
  // A malformed OS_PUBLIC_URL is a deployment error and throws (the route answers 500), never "no redirect".
  const canonical = new URL(env);
  const req = new URL(reqUrl);
  const host = (requestHost ?? req.host).toLowerCase();
  if (host === canonical.host.toLowerCase()) return null;
  return `${canonical.origin}${req.pathname}${req.search}`;
}

/** The OS pages an OAuth callback may return to (the chat, Connections, Files). */
export const RETURN_TO_PATHS: ReadonlySet<string> = new Set(['/', '/home', '/connections', '/unstructured', '/files']);

/**
 * Where to land after an OAuth callback, or null: only one of `RETURN_TO_PATHS` (the query is
 * dropped), so the value can never send the user to another site or an unexpected page.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string' || value.length > 300) return null;
  const path = value.split(/[?#]/, 1)[0];
  return RETURN_TO_PATHS.has(path) ? path : null;
}

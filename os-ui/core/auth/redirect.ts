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

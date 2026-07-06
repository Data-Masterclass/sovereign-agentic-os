/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The absolute base + callback URI the OAuth flow uses. The redirect URI MUST be
 * byte-identical between the authorize step and the token exchange, and MUST match
 * one registered on the provider app — so both routes derive it here. Prefer the
 * configured public origin (`OS_PUBLIC_URL`, e.g. https://agentic.datamasterclass.com
 * on the deploy); fall back to the request origin for local dev.
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

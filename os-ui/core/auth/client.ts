/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OAuth token client — code exchange, silent refresh and a live drive probe
 * USER STORY: As a user connecting my Google Drive or OneDrive I want the OS to exchange and
 *             refresh my tokens on the server so that my files sync without my credentials
 *             leaving the server.
 * ARCHITECTURE:
 *   - Server-only. The one place the admin-registered client secret is read (via
 *     `getClientCredentials` in `oauth-apps.ts`) and sent, only to the provider's token endpoint.
 *   - Builds request bodies with `token-set.ts` and endpoints from `providers.ts`; called by
 *     `connection-token.ts`, `tabs/connections/lib/store.ts` and the OAuth callback route.
 *   - Failures throw an Error tagged with an HTTP status; response bodies are never echoed.
 *   - `probeDrive` calls the provider's cheap read endpoint to check that a token really works.
 */
import 'server-only';
import {
  type TokenSet,
  type TokenResponse,
  tokenSetFromResponse,
  exchangeBody,
  refreshBody,
} from '@core/auth/token-set';
import { providerConfig, type OAuthProvider } from '@core/auth/providers';
import { getClientCredentials } from '@core/auth/oauth-apps';

async function postForm(url: string, body: URLSearchParams, ms = 10000): Promise<TokenResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Do NOT echo the response body — it can contain sensitive error detail.
      const err = new Error(`Token endpoint returned ${res.status}`);
      (err as Error & { status?: number }).status = 502;
      throw err;
    }
    return (await res.json()) as TokenResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange an authorization code for a token set (server-side). */
export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
): Promise<TokenSet> {
  const creds = getClientCredentials(provider);
  if (!creds) {
    const err = new Error(`OAuth app for ${provider} is not configured by an administrator`);
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  const cfg = providerConfig(provider);
  const json = await postForm(cfg.tokenUrl, exchangeBody({ ...creds, code, redirectUri }));
  const ts = tokenSetFromResponse(json, Math.floor(Date.now() / 1000));
  if (!ts) {
    const err = new Error('Token endpoint did not return an access token');
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  return ts;
}

/**
 * Silent refresh of an expiring access token. Returns the new token set (carrying
 * the prior refresh token if the provider omitted one). Throws on failure so the
 * caller can mark the connection needs-reconnect.
 */
export async function refreshTokens(provider: OAuthProvider, prev: TokenSet): Promise<TokenSet> {
  if (!prev.refreshToken) {
    const err = new Error('No refresh token available; the connection must be reconnected');
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
  const creds = getClientCredentials(provider);
  if (!creds) {
    const err = new Error(`OAuth app for ${provider} is not configured`);
    (err as Error & { status?: number }).status = 409;
    throw err;
  }
  const cfg = providerConfig(provider);
  const json = await postForm(cfg.tokenUrl, refreshBody({ ...creds, refreshToken: prev.refreshToken }));
  const ts = tokenSetFromResponse(json, Math.floor(Date.now() / 1000), prev);
  if (!ts) {
    const err = new Error('Refresh did not return an access token');
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  return ts;
}

/**
 * HONEST reachability probe: call the provider's cheap read endpoint (Drive
 * `about.get` / Graph `/me/drive`) with the resolved access token. A 2xx means the
 * token really works against the live API; anything else is an honest failure. The
 * token is sent ONLY to the provider over TLS — never returned, logged, or traced.
 */
export async function probeDrive(
  provider: OAuthProvider,
  accessToken: string,
  ms = 8000,
): Promise<{ ok: boolean; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(providerConfig(provider).probeUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

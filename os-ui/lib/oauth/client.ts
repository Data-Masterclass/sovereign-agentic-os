/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  type TokenSet,
  type TokenResponse,
  tokenSetFromResponse,
  exchangeBody,
  refreshBody,
} from './token-set.ts';
import { providerConfig, type OAuthProvider } from './providers.ts';
import { getClientCredentials } from './oauth-apps.ts';

/**
 * The fetch-backed OAuth token client — the ONLY place a client secret leaves
 * Secrets Manager, and it goes ONLY to the provider's token endpoint over TLS,
 * server-side. The secret is never returned, logged, or traced. Both calls throw
 * a tagged Error on failure (never leaking response bodies that might echo a
 * secret) so the caller can decide fall-back vs. surface.
 */

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

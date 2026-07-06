/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The OAuth token set + the PURE request builders for the drive OAuth flow — no
 * network, no secrets vault, no server-only imports, so every branch is unit-
 * testable. The server modules (`client.ts`, `connection-token.ts`) call these to
 * build the authorize URL / the token-exchange + refresh request bodies, and to
 * parse + serialize the token set that lands in Secrets Manager.
 *
 * A token set is the shape stored (as JSON) under the Connection's `secretRef`.
 * The raw JSON NEVER leaves the server (it is the credential); only a fingerprint
 * is ever surfaced. A connection that has only the offline placeholder token (a
 * plain non-JSON string) parses to `null` here → the sync falls back to the mock.
 */

import { type OAuthProviderConfig } from './providers.ts';

export type TokenSet = {
  accessToken: string;
  /** Present when the provider returned one (Google needs offline+consent; MS needs offline_access). */
  refreshToken?: string;
  /** Absolute expiry, epoch SECONDS. */
  expiresAt: number;
  /** Granted scopes (space-joined), for audit. */
  scope?: string;
  tokenType?: string;
};

/** The raw JSON a provider's token endpoint returns. */
export type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

/** Build a TokenSet from a provider token-endpoint response (now = epoch seconds). */
export function tokenSetFromResponse(res: TokenResponse, nowSec: number, prev?: TokenSet): TokenSet | null {
  const accessToken = typeof res.access_token === 'string' ? res.access_token : '';
  if (!accessToken) return null;
  const expiresIn = typeof res.expires_in === 'number' && Number.isFinite(res.expires_in) ? res.expires_in : 3600;
  return {
    accessToken,
    // On refresh, some providers (Google) omit the refresh_token — keep the prior one.
    refreshToken: typeof res.refresh_token === 'string' && res.refresh_token ? res.refresh_token : prev?.refreshToken,
    expiresAt: nowSec + expiresIn,
    scope: typeof res.scope === 'string' ? res.scope : prev?.scope,
    tokenType: typeof res.token_type === 'string' ? res.token_type : 'Bearer',
  };
}

/** Serialize a token set for Secrets Manager (server-side only; never returned to a client). */
export function serializeTokenSet(ts: TokenSet): string {
  return JSON.stringify(ts);
}

/**
 * Parse a stored secret into a TokenSet, or null when it is not a real token set
 * (e.g. the offline mock placeholder, an empty string, or malformed JSON). A null
 * result means "no live token" → the caller falls back to the mock client.
 */
export function parseTokenSet(raw: string | null | undefined): TokenSet | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null; // mock placeholder / opaque string
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    if (typeof o.accessToken !== 'string' || !o.accessToken) return null;
    const expiresAt = typeof o.expiresAt === 'number' ? o.expiresAt : 0;
    return {
      accessToken: o.accessToken,
      refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : undefined,
      expiresAt,
      scope: typeof o.scope === 'string' ? o.scope : undefined,
      tokenType: typeof o.tokenType === 'string' ? o.tokenType : undefined,
    };
  } catch {
    return null;
  }
}

/** Is the access token expired (or within the skew window)? Default 60s skew. */
export function isExpired(ts: TokenSet, nowSec: number, skewSec = 60): boolean {
  return nowSec >= ts.expiresAt - skewSec;
}

/**
 * Build the provider authorization URL the user is redirected to for consent.
 * `state` is the signed CSRF token; `redirectUri` MUST exactly match one
 * registered on the provider app.
 */
export function buildAuthorizeUrl(
  cfg: OAuthProviderConfig,
  input: { clientId: string; redirectUri: string; state: string },
): string {
  const u = new URL(cfg.authUrl);
  u.searchParams.set('client_id', input.clientId);
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', input.state);
  for (const [k, v] of Object.entries(cfg.extraAuthParams)) u.searchParams.set(k, v);
  return u.toString();
}

/** The x-www-form-urlencoded body for the code→token exchange. */
export function exchangeBody(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): URLSearchParams {
  return new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
}

/** The x-www-form-urlencoded body for a refresh-token grant. */
export function refreshBody(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): URLSearchParams {
  return new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
}

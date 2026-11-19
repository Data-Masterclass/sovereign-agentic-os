/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connection token bridge — store an OAuth token set and resolve a live access token
 * USER STORY: As a user with a connected drive I want the OS to refresh an expired token on its
 *             own so that my sync keeps running without reconnecting.
 * ARCHITECTURE:
 *   - Server-only. Stores the token set as JSON in Secrets Manager under the connection's existing
 *     `secretRef`, and re-stores it after a silent refresh (`client.ts` `refreshTokens`, injectable).
 *   - `resolveAccessToken` returns `live`, `none` (no real token stored, e.g. the offline
 *     placeholder, so the sync uses the mock client) or `needs-reconnect`.
 *   - Called by `tabs/connections/lib/store.ts`. The token set never leaves the server.
 */
import 'server-only';
import { putSecret, getSecretServerSide, type SecretRef } from '@core/infra/secrets';
import {
  type TokenSet,
  parseTokenSet,
  serializeTokenSet,
  isExpired,
} from '@core/auth/token-set';
import { type OAuthProvider } from '@core/auth/providers';
import { refreshTokens as liveRefresh } from '@core/auth/client';

/** How the resolve step ended, for the caller to update connection health. */
export type TokenResolution =
  | { status: 'live'; accessToken: string; refreshed: boolean }
  | { status: 'none' } // no real token stored (offline placeholder / never connected)
  | { status: 'needs-reconnect'; reason: string }; // expired and refresh failed

/** Persist a freshly-obtained token set on the connection's secret ref. */
export function storeTokens(ref: SecretRef, ts: TokenSet): void {
  putSecret(ref.name, ref.key, serializeTokenSet(ts));
}

/** Read the stored token set (server-side), or null when there isn't a real one. */
export function readTokens(ref: SecretRef): TokenSet | null {
  return parseTokenSet(getSecretServerSide(ref));
}

/**
 * Resolve a live access token for a connection's secret ref, refreshing if stale.
 * `refresh` is injectable for tests; defaults to the live token client. The
 * refreshed set is written back to the SAME ref so the next sync starts fresh.
 */
export async function resolveAccessToken(
  ref: SecretRef,
  provider: OAuthProvider,
  opts: { now?: number; refresh?: (provider: OAuthProvider, prev: TokenSet) => Promise<TokenSet> } = {},
): Promise<TokenResolution> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const refresh = opts.refresh ?? liveRefresh;
  const ts = readTokens(ref);
  if (!ts) return { status: 'none' };
  if (!isExpired(ts, now)) return { status: 'live', accessToken: ts.accessToken, refreshed: false };
  // Expired → attempt a silent refresh.
  if (!ts.refreshToken) return { status: 'needs-reconnect', reason: 'access token expired and no refresh token is stored' };
  try {
    const next = await refresh(provider, ts);
    storeTokens(ref, next);
    return { status: 'live', accessToken: next.accessToken, refreshed: true };
  } catch (e) {
    return { status: 'needs-reconnect', reason: (e as Error).message };
  }
}

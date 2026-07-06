/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { putSecret, getSecretServerSide, type SecretRef } from '@/lib/secrets';
import {
  type TokenSet,
  parseTokenSet,
  serializeTokenSet,
  isExpired,
} from './token-set.ts';
import { type OAuthProvider } from './providers.ts';
import { refreshTokens as liveRefresh } from './client.ts';

/**
 * The bridge between a Connection's `secretRef` and a usable Drive/Graph access
 * token. Stores the OAuth token set (JSON) in Secrets Manager under the SAME ref
 * the Connection already holds, and resolves a live access token for the sync —
 * silently REFRESHING it (and re-storing) when it has expired.
 *
 * The token set is the credential: it never leaves the server, never enters a
 * trace, log, or client response. A connection that holds only the offline mock
 * placeholder resolves to `null` → the sync falls back to the mock client.
 */

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

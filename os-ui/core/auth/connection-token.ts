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
import { putSecret, getSecretServerSide, awaitSecretWrites, type SecretRef } from '@core/infra/secrets';
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
  | { status: 'live'; accessToken: string; refreshed: boolean; /** false: a refreshed token set did not reach the durable store (queued for retry; a health warning says so). */ persisted?: boolean }
  | { status: 'none' } // no real token stored (offline placeholder / never connected)
  | { status: 'needs-reconnect'; reason: string }; // expired and refresh failed

/** Persist a freshly-obtained token set on the connection's secret ref. */
export function storeTokens(ref: SecretRef, ts: TokenSet): void {
  putSecret(ref.name, ref.key, serializeTokenSet(ts));
}

/**
 * Persist a SILENTLY REFRESHED token set. Conflict policy 'adopt': if the other pod stored a token set
 * for this ref since we read it (it refreshed too — and a rotating refresh token makes only the newest
 * set valid), its value wins over ours. Resolves whether the write reached the durable store; a
 * failure is logged here and stays queued for retry (and on `/api/status`) — never silently dropped.
 */
export async function storeRefreshedTokens(ref: SecretRef, ts: TokenSet): Promise<{ persisted: boolean; error?: string }> {
  putSecret(ref.name, ref.key, serializeTokenSet(ts), 'adopt');
  try {
    await awaitSecretWrites([ref]);
    return { persisted: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[connection-token] refreshed token for ${ref.name} not yet durable (retrying): ${error}`);
    return { persisted: false, error };
  }
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
    const saved = await storeRefreshedTokens(ref, next);
    return { status: 'live', accessToken: next.accessToken, refreshed: true, persisted: saved.persisted };
  } catch (e) {
    return { status: 'needs-reconnect', reason: (e as Error).message };
  }
}

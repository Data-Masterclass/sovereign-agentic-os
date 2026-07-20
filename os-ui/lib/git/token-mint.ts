/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Per-user Forgejo token MINT (#146 Phase 2, Option B — ADR 0006). A PURE
 * orchestration module: given a `ForgejoAdminClient`, the caller's OS identity, and
 * mint options, it ensures the caller's mirrored Forgejo user exists and mints a
 * SHORT-TTL, repo-scoped access token AS that user, returning the EXACT `sos git`
 * contract object. No `server-only`/`config`/network here — the route injects the
 * real client + the resolved config values — so the mint contract is unit-testable
 * against an in-memory fake.
 *
 * THE CONTRACT (must match exactly — `sos git` depends on it):
 *   { token, username, expiresAt, scopes, forgejoBaseUrl }
 * - `token`      — the opaque Forgejo access token value. SECRET: returned ONCE to
 *                  the authenticated caller; NEVER logged, stored, or echoed.
 * - `username`   — the caller's mirrored Forgejo user (from `forgejoUsername`).
 * - `expiresAt`  — ISO8601 revoke-by horizon (mint time + TTL). Forgejo has no
 *                  server-enforced TTL, so this is the OS's revoke-by contract; the
 *                  token name carries the mint epoch so the revoke path can sweep it.
 * - `scopes`     — the REPO names the token is intended for: the shared `analytics`
 *                  monorepo (domain = directory) plus any requested repos the caller
 *                  may access. Default: `['analytics']`.
 * - `forgejoBaseUrl` — the git base URL the helper clones/pushes against.
 *
 * SECRET HYGIENE: the token value is placed ONLY on the returned object's `token`
 * field. This module logs nothing; the route returns the object once and never
 * persists it. The token NAME is non-secret (carries only username + mint epoch).
 */

import type { ForgejoAdminClient } from './forgejo-admin.ts';
import { ensureForgejoUser } from './forgejo-users.ts';

/** The OS caller identity the mint scopes on (session principal — never trusted
 *  from the request body). */
export type MintCaller = { id: string; domains: string[] };

/** Config the route resolves from `config` + `@/lib/core/config` and injects (so
 *  this module stays free of `server-only`). */
export type MintConfig = { forgejoBaseUrl: string; ttlSeconds: number };

/** Optional mint inputs. `repos` narrows/extends the scope to specific repo names;
 *  each is filtered to what the caller may access before it reaches the token. */
export type MintOptions = { repos?: string[]; now?: () => number };

/** The EXACT response contract the `sos git` credential helper consumes. */
export type MintResult = {
  token: string;
  username: string;
  expiresAt: string;
  scopes: string[];
  forgejoBaseUrl: string;
};

/** The shared analytics monorepo — always in scope (domain = directory inside it). */
export const ANALYTICS_REPO = 'analytics';

/** The name-prefix every OS-minted token carries, so the revoke path can find + sweep
 *  the caller's prior OS-minted tokens (bounded footprint) without touching any
 *  hand-created token. Includes the username so it is unique per mirrored user. */
export function tokenNamePrefix(username: string): string {
  return `sos-git-${username}-`;
}

/**
 * The set of repos a caller may scope a token to. `analytics` is always allowed
 * (the shared monorepo — DLS inside it is enforced by directory + branch protection,
 * not by repo membership). A `<domain>` repo is allowed iff the caller is a member of
 * that domain. Any requested repo the caller can't access is DROPPED (never an error
 * that leaks which repos exist). With no `repos` requested, the default is exactly
 * `['analytics']`.
 */
export function allowedRepos(caller: MintCaller, requested?: string[]): string[] {
  const domainSet = new Set(caller.domains);
  const base = [ANALYTICS_REPO];
  if (!requested || requested.length === 0) return base;
  const extra = requested
    .map((r) => String(r).trim())
    .filter((r) => r.length > 0)
    .filter((r) => r === ANALYTICS_REPO || domainSet.has(r));
  return [...new Set([...base, ...extra])];
}

/**
 * The coarse Forgejo token scopes. Forgejo access-token scopes are coarse
 * (`read:repository`/`write:repository` — no per-repo granularity in the token
 * itself), so a clone+push token carries read+write repository. Per-repo isolation
 * comes from the `scopes` (repo-name) contract + Forgejo branch protection, not from
 * the token scope string. Kept as its own function so a future read-only mode (e.g.
 * a CI checkout token) is a one-line change.
 */
export function forgejoScopes(): string[] {
  return ['read:repository', 'write:repository'];
}

/**
 * Mint the token. Sequence: (1) sweep the caller's prior OS-minted tokens
 * (best-effort, bounds the footprint), (2) ensure the mirrored Forgejo user exists,
 * (3) mint a scoped token AS that user, (4) assemble the exact contract. Any admin-
 * client failure propagates so the route returns an honest error — never a fake token.
 */
export async function mintToken(
  admin: ForgejoAdminClient,
  caller: MintCaller,
  cfg: MintConfig,
  opts: MintOptions = {},
): Promise<MintResult> {
  const now = opts.now ? opts.now() : Date.now();
  const username = await ensureForgejoUser(admin, caller.id);

  // Sweep prior OS-minted tokens for this user (best-effort — a stale token that
  // can't be deleted must not block a fresh mint). Keeps the token footprint bounded
  // and effectively revokes the previous short-TTL token on each `sos login` refresh.
  await admin.deleteTokensByPrefix(username, tokenNamePrefix(username)).catch(() => ({ deleted: 0 }));

  const scopes = allowedRepos(caller, opts.repos);
  // The token name carries the mint epoch (non-secret) so the central revoke path can
  // identify + sweep expired tokens by name without ever reading the token value.
  const name = `${tokenNamePrefix(username)}${now}`;
  const minted = await admin.createToken(username, name, forgejoScopes());

  const expiresAt = new Date(now + cfg.ttlSeconds * 1000).toISOString();
  return {
    token: minted.value,
    username,
    expiresAt,
    scopes,
    forgejoBaseUrl: cfg.forgejoBaseUrl,
  };
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Forgejo ADMIN git client contract used by the per-user token-mint lane
 * (#146 Phase 2, Option B — ADR 0006). It is the SMALL admin-API surface the mint
 * route needs — create a user that mirrors an OS identity, mint a scoped access
 * token AS that user, and delete stale tokens — layered on the SAME `config.forgejo*`
 * admin credential + REST shape the registry→git mirror and Build adapters use
 * (`lib/agents/build/live-clients.ts`, `app/api/analytics/apply/route.ts`). We do
 * NOT open a second HTTP client: the real impl reuses that exact basic-auth `/api/v1`
 * pattern, and the interface stays a PURE type so the mint logic is unit-testable
 * against an in-memory fake with no network.
 *
 * SECRET HYGIENE: the admin credential and every minted token are WRITE-ONLY. They
 * flow admin-cred → request header and token → the single governed mint response;
 * they are NEVER logged, echoed, stored in the registry, or committed. The real
 * client below reads the admin cred from `config` (mounted secret) and returns the
 * token to exactly one caller — the mint route — which hands it to the authenticated
 * user once. No method here accepts or returns a plaintext user password.
 */

/** A minted Forgejo access token: the opaque value + the Forgejo-side token name
 *  (so the central revoke path can delete it by name). The `value` is the SECRET —
 *  it appears ONLY in the mint response, never in a log or error string. */
export type MintedForgejoToken = { name: string; value: string };

export interface ForgejoAdminClient {
  /**
   * Idempotently ensure a Forgejo user with `username` exists (SSO/token-only — no
   * usable password is ever exposed). Resolves cleanly when the user already exists
   * (a create race / prior provisioning is a no-op, not an error). `email` is a
   * synthetic per-OS-identity address so Forgejo's required-email constraint is met
   * without leaking the OS user's real email into git. Throws only on a real failure
   * (unreachable / rejected) so the caller reports the sync honestly.
   */
  ensureUser(username: string, email: string): Promise<void>;

  /**
   * Mint an access token AS `username` (admin `sudo`) with the given coarse Forgejo
   * `scopes` (e.g. `read:repository`, `write:repository`). Returns the opaque token
   * value + its name. Throws on failure so the mint route never returns a fake token.
   * The `name` MUST be reproducible by the revoke path so a token can be deleted.
   */
  createToken(username: string, name: string, scopes: string[]): Promise<MintedForgejoToken>;

  /**
   * Delete every token of `username` whose name starts with `namePrefix`. Used by the
   * central revoke path: minting first sweeps the caller's own prior OS-minted tokens
   * (bounded token footprint), and a deactivation hook deletes all of them. Idempotent
   * — a user with no matching tokens (or none at all) resolves cleanly. Best-effort:
   * a per-token delete failure is swallowed so a fresh mint is never blocked by a
   * stale token that can't be removed; a wholly-unreachable Forgejo throws.
   */
  deleteTokensByPrefix(username: string, namePrefix: string): Promise<{ deleted: number }>;
}

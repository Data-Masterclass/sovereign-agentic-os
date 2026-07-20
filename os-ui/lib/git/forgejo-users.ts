/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Forgejo user provisioning that MIRRORS an OS identity (#146 Phase 2, Option B —
 * ADR 0006). A PURE module: it derives the Forgejo username from the OS uid and,
 * given a `ForgejoAdminClient`, idempotently ensures the mirrored Forgejo user
 * exists — created SSO/token-only via the admin API (no password ever exposed).
 * Kept pure + free of `server-only`/`config` so it is unit-testable against an
 * in-memory fake admin client; the real fetch-backed client is injected by the
 * mint route (`lib/git/live-clients.ts`).
 *
 * ROLE MAPPING (conceptual, enforced elsewhere): builder+ OS roles map to Forgejo
 * users allowed to APPROVE on protected branches — the actual enforcement is
 * Forgejo branch protection configured by the chart lane, NOT here. This module
 * only ensures the user account exists; scope + approver rights are applied by the
 * token scopes (token-mint) and branch protection (chart), keeping this seam small.
 */

import type { ForgejoAdminClient } from './forgejo-admin.ts';

/**
 * The Forgejo username mirroring an OS uid. Forgejo usernames must be a limited
 * charset (alphanumerics, `-`, `_`, `.`; not starting/ending with a separator),
 * so we sanitize: lowercase, non-allowed chars → `-`, collapse runs, trim
 * separators. A stable `os-` prefix namespaces OS-mirrored users away from any
 * hand-created Forgejo accounts and guarantees a non-empty, non-numeric-leading
 * name even for exotic uids. Deterministic — the same uid always maps to the same
 * Forgejo user, so provisioning + minting are repeatable.
 */
export function forgejoUsername(uid: string): string {
  const slug = String(uid)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  // Forgejo caps usernames at 40 chars; keep headroom under the `os-` prefix.
  return `os-${slug || 'user'}`.slice(0, 40).replace(/[-._]+$/g, '');
}

/**
 * A synthetic, per-identity email for the mirrored Forgejo user. Forgejo requires a
 * unique email on create; we DERIVE one from the mirrored username so the OS user's
 * real email is never written into git, and the address is stable + collision-free
 * across OS identities. The domain is a non-routable reserved TLD (RFC 2606) so it
 * can never receive mail.
 */
export function forgejoEmail(username: string): string {
  return `${username}@os-git.invalid`;
}

/**
 * Idempotently ensure the Forgejo user mirroring `uid` exists. Returns the resolved
 * Forgejo username so the caller can mint AS it. Called on demand by the mint route
 * (sync-on-mint) — a second call for the same uid is a cheap no-op (the admin
 * client resolves "already exists" cleanly). Never handles a password: the account
 * is token-only.
 */
export async function ensureForgejoUser(admin: ForgejoAdminClient, uid: string): Promise<string> {
  const username = forgejoUsername(uid);
  await admin.ensureUser(username, forgejoEmail(username));
  return username;
}

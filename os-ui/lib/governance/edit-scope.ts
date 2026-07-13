/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';

/**
 * The ONE fail-closed edit-scope rule for every ownable OS artifact.
 *
 * A SHARED / Marketplace / Certified artifact may be VIEWED and USED by anyone in
 * the domain, but MUTATED (edit / archive / delete / demote-unshare) only by:
 *   • the OWNER — even if they are just a Creator/Builder,
 *   • a `domain_admin` OF THE OWNING DOMAIN, or
 *   • a platform `admin` (tenant-wide).
 *
 * A non-owner Builder must NOT be able to mutate someone else's shared artifact —
 * this closes the gap where per-type predicates said `owner || builder+`.
 *
 * Pure + edge-safe: the single mutation gate every store shares.
 */
export function canManageArtifact(
  user: { id: string; role: Role; domains: string[] },
  art: { owner: string; domain: string },
): boolean {
  return (
    art.owner === user.id ||
    (user.role === 'domain_admin' && user.domains.includes(art.domain)) ||
    user.role === 'admin'
  );
}

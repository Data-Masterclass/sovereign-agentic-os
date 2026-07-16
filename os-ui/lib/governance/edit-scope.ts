/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';

/**
 * The scope tier of an artifact, normalised across every tab's own vocabulary
 * (Personal/Shared/Certified, personal/shared/marketplace/certified,
 * private/domain/product, dataset/asset/product, personal/domain/marketplace …).
 * Only the PERSONAL/private tier is privacy-sensitive; everything above it is
 * shared into (at least) a domain.
 *
 *   • 'personal' — owner-private, shared with no one.
 *   • 'shared'   — shared into the owning domain (Shared / domain / asset).
 *   • 'certified'— published cross-domain (Certified / Marketplace / product).
 */
export type ArtifactScope = 'personal' | 'shared' | 'certified';

/**
 * The ONE fail-closed edit-scope rule for every ownable OS artifact.
 *
 * PERSONAL ("My") artifact — owner-private, not shared with anyone:
 *   • MUTATED and VIEWED only by its OWNER.
 *   • NEITHER a domain_admin NOR a platform/tenant admin may touch or view another
 *     user's Personal artifact — privacy is absolute for the private tier.
 *
 * SHARED (domain) / CERTIFIED (company/marketplace) artifact — visible to the
 * domain (or tenant), MUTATED only by:
 *   • the OWNER — even a bare Creator/Builder,
 *   • a `domain_admin` OF THE OWNING DOMAIN, or
 *   • a platform `admin` (tenant-wide, any domain).
 *
 * A non-owner Builder/Creator must NOT mutate someone else's shared artifact.
 *
 * `scope` is REQUIRED by every caller. It is optional in the signature only so the
 * type stays additive, but an OMITTED scope is treated as 'shared' — the historical
 * behaviour — so a caller that forgets it never accidentally widens admin reach into
 * a private artifact; the personal-privacy close is opt-in per caller and each caller
 * DOES pass it. Fail-closed: an unknown scope value collapses to the shared rule
 * (never to owner-only bypass, never to open).
 *
 * Pure + edge-safe: the single mutation gate every store shares.
 */
export function canManageArtifact(
  user: { id: string; role: Role; domains: string[] },
  art: { owner: string; domain: string; scope?: ArtifactScope },
): boolean {
  // The owner always manages (and views) their own artifact, at any tier.
  if (art.owner === user.id) return true;
  // PERSONAL is owner-only: no admin, no domain_admin — privacy is absolute.
  if (art.scope === 'personal') return false;
  // SHARED / CERTIFIED (or an unspecified/unknown scope → treat as shared):
  //   in-domain domain_admin, or a platform admin (any domain).
  return (
    (user.role === 'domain_admin' && user.domains.includes(art.domain)) ||
    user.role === 'admin'
  );
}

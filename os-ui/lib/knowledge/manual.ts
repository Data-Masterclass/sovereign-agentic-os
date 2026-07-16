/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../core/session.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';

/**
 * The Operating Model comes in THREE scopes, each a guided-sections card that
 * reuses the same `DomainKnowledge` shape (general / strategy / business /
 * organization / architecture / data / glossary) but is keyed + governed differently:
 *
 *   • my      — a PERSONAL manual, one per user. Read + edit: OWNER only.
 *   • domain  — the existing per-domain operating manual. Read: everyone in the
 *               domain. Edit: domain_admin+ / owner (the shared-edit rule).
 *   • company — a TENANT-wide manual, one for the whole org. Read: everyone.
 *               Edit: platform admin only.
 *
 * All three ride the SAME `DomainKnowledge` store + version log, distinguished by
 * a reserved storage KEY so their records and histories stay independent:
 *   my      → `user:<id>`
 *   domain  → `<domain>`            (the real domain id — unchanged)
 *   company → `tenant`
 *
 * This module is pure (no server/network imports) so the gating is unit-testable
 * and shared by both the store and its API routes — never trust the client.
 */

export type ManualScope = 'my' | 'domain' | 'company';

/** Reserved storage keys that must never collide with a real domain id. */
export const COMPANY_KEY = 'tenant';
export const MY_KEY_PREFIX = 'user:';

export type ManualPrincipal = { id: string; domains: string[]; role: Role };

export type ManualResolution = {
  scope: ManualScope;
  /** The storage key for this scope (domain map + version log key). */
  key: string;
  canView: boolean;
  canEdit: boolean;
};

/**
 * Resolve a scope + principal to its storage key and per-scope read/edit gating.
 * `domain` is required for the domain scope (defaults to the caller's first
 * domain when omitted). Fail-closed: an unknown scope grants nothing.
 */
export function resolveManual(
  scope: ManualScope,
  user: ManualPrincipal,
  domain?: string,
): ManualResolution {
  if (scope === 'my') {
    const key = `${MY_KEY_PREFIX}${user.id}`;
    // Owner-only: the key IS the user, so anyone resolving their own scope owns it.
    return { scope, key, canView: true, canEdit: true };
  }
  if (scope === 'company') {
    return {
      scope,
      key: COMPANY_KEY,
      canView: true, // everyone reads the company manual
      canEdit: user.role === 'admin', // platform admin only
    };
  }
  // domain
  const dom = domain && user.domains.includes(domain) ? domain : user.domains[0] ?? 'default';
  const inDomain = user.domains.includes(dom);
  return {
    scope,
    key: dom,
    canView: inDomain, // everyone in the domain reads it
    // Shared-edit rule on an owner-less domain card → domain_admin OF this domain,
    // or a platform admin. A creator/builder never matches (empty owner). The
    // 'shared' scope keeps this a domain artifact (never treated as owner-private).
    canEdit: inDomain && canManageArtifact(user, { owner: '', domain: dom, scope: 'shared' }),
  };
}

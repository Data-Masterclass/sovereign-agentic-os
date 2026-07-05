/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Scope, ScopeLevel } from './types.ts';

/**
 * PURE scope predicates (no IO) — the testable heart of the OPA-scoping spine.
 * Kept free of `server-only`/config imports so the security invariants run under
 * `node --test`. `scope.ts` adds the async `scopeForUser` (the Ory→OPA resolve)
 * on top of these.
 */

export const ROLE_LEVEL: Record<string, ScopeLevel> = {
  'creator': 'user',
  builder: 'builder',
  // A domain admin's monitoring scope is domain-wide (like a builder) — never
  // cluster/tenant-wide, which stays admin-only.
  domain_admin: 'builder',
  admin: 'admin',
};

/** Derive a scope from identity claims (role + domains). The pure mapping. */
export function deriveScope(
  role: string,
  principal: string,
  domains: string[],
  via: Scope['via'] = 'identity',
): Scope {
  const level = ROLE_LEVEL[role] ?? 'user';
  return { level, principal, domains: [...domains], cluster: level === 'admin', via };
}

/**
 * THE scope predicate. A signal is visible iff:
 *   • admin                                  → always (cluster signals too)
 *   • cluster-wide signal (node/self-heal)   → admin only
 *   • builder                                → its domain ∈ the viewer's domains
 *   • user                                   → it is owned by the viewer
 */
export function canSee(
  scope: Scope,
  it: { owner: string; domain: string; cluster?: boolean },
): boolean {
  if (scope.level === 'admin') return true;
  if (it.cluster) return false; // cluster/tenant signals are admin-only
  if (scope.level === 'builder') return scope.domains.includes(it.domain);
  return it.owner === scope.principal; // user: strictly their own
}

/** Filter a list to the viewer's scope (used by every adapter roll-up). */
export function filterScope<T extends { owner: string; domain: string; cluster?: boolean }>(
  scope: Scope,
  items: T[],
): T[] {
  return items.filter((it) => canSee(scope, it));
}

/**
 * The drill-into-trace gate. Throws 404 if missing, 403 if out of scope — so a
 * User cannot open another user's trace by guessing its id. Single check the
 * trace route awaits before returning any step/log.
 */
export function assertInScope(
  scope: Scope,
  it: { owner: string; domain: string; cluster?: boolean } | null | undefined,
): void {
  if (!it) {
    const e = new Error('Not found');
    (e as Error & { status?: number }).status = 404;
    throw e;
  }
  if (!canSee(scope, it)) {
    const e = new Error('Out of scope');
    (e as Error & { status?: number }).status = 403;
    throw e;
  }
}

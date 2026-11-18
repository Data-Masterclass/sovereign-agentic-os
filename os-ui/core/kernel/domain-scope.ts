/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core/kernel
 * FEATURE:    One predicate for "does this artifact belong in a feed narrowed to ONE domain"
 * USER STORY: As a user who belongs to several domains I want every picker to offer the domain I am
 *             working in, not the union of everything I may see — without losing marketplace items
 *             or an unassigned artifact I still have to file.
 * ARCHITECTURE:
 *   - Pure + client-safe, imports nothing. It lives in the kernel because BOTH the agents grant
 *     feed (`tabs/agents/lib/grant-feed.ts`) and the tab-agnostic context feed
 *     (`tabs/software/lib/available-context.ts`) need it, and a tab may not import another tab.
 *   - NARROWING ONLY. This never admits an item a lister did not already hand over, so it cannot
 *     widen access: the canView/DLS gate inside each lister stays the authorisation decision and
 *     this is a presentation filter on top of it.
 *   - Distinct from `active-domain.ts`, which answers "which domain am I working in"; this
 *     answers "given that domain, does this ROW belong in the list".
 */

/** The three tiers every artifact feed groups by (My · Domain · Company/Marketplace). */
export type ScopeTier = 'personal' | 'domain' | 'marketplace';

/** The minimum an item must expose to be narrowed: its tier and its home domain. */
export type DomainScoped = { scope: ScopeTier; domain?: string | null };

/**
 * True when `item` belongs in a feed narrowed to `target`.
 *
 * Three carve-outs, each deliberate:
 *   • `target === null` — there is no domain context ("All domains", or a system with no
 *     domain). Nothing is narrowed; picking one of the user's domains arbitrarily would hide
 *     artifacts they explicitly asked to see across all of them.
 *   • `marketplace` — always kept. A certified product is discoverable across domains by
 *     design; narrowing it would remove grants that work today.
 *   • a domainless item (`undefined` / `null` / `''`) — always kept, exactly as every tab's
 *     own list does, so an unassigned artifact stays findable and an admin can domain-move it.
 */
export function inDomainScope(item: DomainScoped, target: string | null): boolean {
  if (target === null) return true;
  if (item.scope === 'marketplace') return true;
  if (!item.domain) return true;
  return item.domain === target;
}

/** `items` filtered through {@link inDomainScope}; order and item objects are preserved. */
export function narrowToDomainScope<T extends DomainScoped>(items: T[], target: string | null): T[] {
  return items.filter((i) => inDomainScope(i, target));
}

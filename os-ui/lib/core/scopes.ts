/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * SCOPE vocabulary + grouping — the ONE artifact-scope model shared across the
 * whole OS. This module is the SINGLE SOURCE OF TRUTH for the words users see
 * when they think about "how far does this reach": every artifact list (Data,
 * Files, Knowledge, Workflows, Agents, Dashboards, Metrics, Big Bets, Software,
 * Connections, Science, Marketplace) slices the caller's visible items into the
 * SAME four groups and labels them with the SAME nouns and verbs.
 *
 *   All      — everything the caller can see (union of the three groups)
 *   My …     — the caller's OWN, un-promoted (Personal-tier) items. Once an
 *              item is promoted it moves to Domain/Company and leaves "My".
 *   Domain   — shared to the caller's domain (tier `asset` / visibility Shared)
 *   Company  — certified, cross-domain (tier `product` / visibility Marketplace)
 *
 * VOCABULARY (locked): the scope LABELS are All · My · Domain · Company
 * (e.g. "My Data", "Domain Data", "Company Data"), matching the Strategic
 * Pillars / Operating Manual scopes. The promotion VERBS read "Promote to
 * Domain" (Personal → Shared) and "Certify to Company" (Shared → Certified).
 *
 * IMPORTANT — this is a DISPLAY vocabulary only. The internal enum / persisted
 * values are UNCHANGED: `ScopeKey` stays `mine|shared|marketplace`, the store
 * payload stays `{ mine, domain, marketplace }`, and visibility values stay
 * `Personal|Shared|Certified|Marketplace`. Only the human-facing strings below
 * moved from "Shared in Domain"/"Marketplace" to "Domain"/"Company".
 *
 * SEMANTICS are lifted verbatim from the Data tab's `dataset-scopes.ts`:
 *   • the store already returns a canView-scoped `{ mine, domain, marketplace }`
 *     payload (grouped server-side by tier/visibility);
 *   • "All"    = the union of all three groups;
 *   • "My"     = the caller's OWN Personal-tier items only (the store's `mine`
 *                group). A Domain/Company item the caller authored does NOT
 *                appear under My — once promoted it lives under Domain/Company
 *                (and All) only, so "My" stays the private, un-promoted drawer;
 *   • "Domain" = the `domain` group as returned by the store;
 *   • "Company" = the `marketplace` group as returned by the store.
 *
 * Pure + client-safe (no server-only / Next imports): this only re-slices an
 * already-authz'd payload for DISPLAY. Authz stays in the stores.
 */

export type ScopeKey = 'all' | 'mine' | 'shared' | 'marketplace';

/** The ordered four groups. `label(kind?)` renders "My Data", "All", etc. */
export const SCOPE_GROUPS: { key: ScopeKey; label: (kind?: string) => string }[] = [
  { key: 'all', label: (kind) => (kind ? `All ${kind}` : 'All') },
  { key: 'mine', label: (kind) => (kind ? `My ${kind}` : 'My') },
  { key: 'shared', label: (kind) => (kind ? `Domain ${kind}` : 'Domain') },
  { key: 'marketplace', label: (kind) => (kind ? `Company ${kind}` : 'Company') },
];

/** One place to render a scope's user-facing label. `scopeLabel('mine', 'Data') → "My Data"`. */
export function scopeLabel(key: ScopeKey, kind?: string): string {
  return SCOPE_GROUPS.find((g) => g.key === key)!.label(kind);
}

/** A stored visibility/tier value — internal, unchanged. Mapped to a scope for DISPLAY. */
export type Visibility = 'Personal' | 'Shared' | 'Certified' | 'Marketplace' | string;

/**
 * Map a persisted visibility/tier value to its scope key. This is how an artifact
 * BADGE reads the same word ("Domain", "Company") everywhere without re-hardcoding
 * strings per tab. Internal values are unchanged — this only interprets them.
 *   Personal            → 'mine'   ("My")
 *   Shared              → 'shared' ("Domain")
 *   Certified/Marketplace → 'marketplace' ("Company")
 */
export function visibilityScope(visibility: Visibility): ScopeKey {
  if (visibility === 'Shared') return 'shared';
  if (visibility === 'Certified' || visibility === 'Marketplace') return 'marketplace';
  return 'mine';
}

/** Display label for a stored visibility/tier value — routes through `scopeLabel`. */
export function visibilityLabel(visibility: Visibility, kind?: string): string {
  return scopeLabel(visibilityScope(visibility), kind);
}

/**
 * The promotion VERBS, one place. The ladder is Personal → Shared → Certified
 * under the hood; users read it as "Promote to Domain" then "Certify to Company".
 *   fromVisibility 'Personal' → "Promote to Domain"
 *   fromVisibility 'Shared'   → "Certify to Company"
 * `propose` softens the Personal rung to "Propose to Domain" for a non-approver.
 */
export function promoteVerb(fromVisibility: Visibility, opts: { propose?: boolean } = {}): string {
  if (fromVisibility === 'Shared') return 'Certify to Company';
  return opts.propose ? 'Propose to Domain' : 'Promote to Domain';
}

/**
 * The DEMOTION (revoke-sharing) VERBS — the mirror of {@link promoteVerb}, one
 * place so every tab's "step down the ladder" control reads the same words.
 *   fromVisibility 'Certified'/'Marketplace' → "Revoke from Company"  (→ Domain)
 *   fromVisibility 'Shared'                   → "Unshare"             (→ My)
 * A Personal item is already at the bottom → '' (nothing to revoke).
 */
export function demoteVerb(fromVisibility: Visibility): string {
  if (fromVisibility === 'Certified' || fromVisibility === 'Marketplace') return 'Revoke from Company';
  if (fromVisibility === 'Shared') return 'Unshare';
  return '';
}

/** The `{ mine, domain, marketplace }` payload every OS store returns. */
export type ScopeGroups<T> = { mine: T[]; domain: T[]; marketplace: T[] };

/**
 * Adapter for tabs that return a FLAT list carrying a visibility tier rather than
 * a pre-grouped `{ mine, domain, marketplace }` payload (e.g. Connections,
 * Software). Buckets by the item's visibility so the same `groupByScope` /
 * `scopeCounts` helpers apply. Accepts the two tier vocabularies used across the
 * OS: `Personal|Shared|Certified` and `Personal|Shared|Marketplace`.
 */
export function groupsFromVisibility<
  T extends { visibility: 'Personal' | 'Shared' | 'Certified' | 'Marketplace' },
>(items: T[]): ScopeGroups<T> {
  const domain = items.filter((i) => i.visibility === 'Shared');
  const marketplace = items.filter((i) => i.visibility === 'Certified' || i.visibility === 'Marketplace');
  const mine = items.filter((i) => i.visibility === 'Personal');
  return { mine, domain, marketplace };
}

/** An item that carries an owner — the only field the grouping needs. */
type Owned = { owner: string };

/** The four buckets, each an array. `mine` is OWNERSHIP across the whole union. */
export type ScopedGroups<T> = { all: T[]; mine: T[]; shared: T[]; marketplace: T[] };

/**
 * Slice a store's `{ mine, domain, marketplace }` payload into the four scope
 * buckets. `currentUserId` decides "My" by ownership (matches dataset-scopes).
 */
export function groupByScope<T extends Owned>(
  groups: ScopeGroups<T>,
  currentUserId: string,
): ScopedGroups<T> {
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  return {
    all,
    // "My" = the caller's OWN, un-promoted items only — the store's Personal-tier
    // `mine` group. A promoted item the caller authored lives under Domain/Company
    // (and All), NOT under My, so promoting genuinely moves it out of the private
    // drawer instead of showing it in two places.
    mine: groups.mine.filter((t) => t.owner === currentUserId),
    shared: groups.domain,
    marketplace: groups.marketplace,
  };
}

/** The items one scope shows (no archive split — see `scopedTiles` for that). */
export function itemsForScope<T extends Owned>(
  groups: ScopeGroups<T>,
  scope: ScopeKey,
  currentUserId: string,
): T[] {
  return groupByScope(groups, currentUserId)[scope];
}

/** Per-scope counts for the switcher labels. */
export function scopeCounts<T extends Owned>(
  groups: ScopeGroups<T>,
  currentUserId: string,
): Record<ScopeKey, number> {
  const g = groupByScope(groups, currentUserId);
  return { all: g.all.length, mine: g.mine.length, shared: g.shared.length, marketplace: g.marketplace.length };
}

/**
 * The archive-aware variant used by tabs that soft-archive items: the same four
 * buckets, but each split into an active working list + an archived list, both
 * sorted by a caller-supplied key (default: `name`, falling back to `title`).
 */
export type ScopedTiles<T> = { active: T[]; archived: T[] };

export function tilesForScope<T extends Owned & { archived?: boolean }>(
  groups: ScopeGroups<T>,
  scope: ScopeKey,
  currentUserId: string,
  sortKey: (t: T) => string = (t) => (t as { name?: string; title?: string }).name ?? (t as { title?: string }).title ?? '',
): ScopedTiles<T> {
  const picked = itemsForScope(groups, scope, currentUserId);
  const by = (a: T, b: T) => sortKey(a).localeCompare(sortKey(b));
  return {
    active: picked.filter((t) => !t.archived).sort(by),
    archived: picked.filter((t) => t.archived).sort(by),
  };
}

/** Active-only per-scope counts (archived excluded) for archive-aware tabs. */
export function activeScopeCounts<T extends Owned & { archived?: boolean }>(
  groups: ScopeGroups<T>,
  currentUserId: string,
): Record<ScopeKey, number> {
  return {
    all: tilesForScope(groups, 'all', currentUserId).active.length,
    mine: tilesForScope(groups, 'mine', currentUserId).active.length,
    shared: tilesForScope(groups, 'shared', currentUserId).active.length,
    marketplace: tilesForScope(groups, 'marketplace', currentUserId).active.length,
  };
}

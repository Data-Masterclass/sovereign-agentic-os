/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * SCOPE grouping — the ONE artifact-grouping model shared across the whole OS.
 *
 * Every artifact list (Data, Files, Knowledge, Workflows, Agents, Dashboards,
 * Metrics, Big Bets, Software, Connections) slices the caller's visible items
 * into the SAME four groups:
 *
 *   All          — everything the caller can see (union of the three groups)
 *   My …         — the caller's OWN items (owner), regardless of tier — a
 *                  promoted asset they authored still shows under "My"
 *   Shared       — shared to the caller's domain (tier `asset` / visibility Shared)
 *   Marketplace  — certified, cross-domain (tier `product` / visibility Marketplace)
 *
 * VOCABULARY (locked): the group LABELS are All · My · Shared · Marketplace
 * (e.g. "My Data", "My Files"). The promotion VERBS/BADGES stay
 * Personal → Shared → Certified — only these grouping nouns are unified here.
 *
 * SEMANTICS are lifted verbatim from the Data tab's `dataset-scopes.ts`:
 *   • the store already returns a canView-scoped `{ mine, domain, marketplace }`
 *     payload (grouped server-side by tier/visibility);
 *   • "All"    = the union of all three groups;
 *   • "My"     = OWNERSHIP — everything in the union whose `owner` is the caller,
 *                so a Shared/Marketplace item the caller authored appears under
 *                BOTH All and My (and also under Shared/Marketplace);
 *   • "Shared" = the `domain` group as returned by the store;
 *   • "Market" = the `marketplace` group as returned by the store.
 *
 * Pure + client-safe (no server-only / Next imports): this only re-slices an
 * already-authz'd payload for DISPLAY. Authz stays in the stores.
 */

export type ScopeKey = 'all' | 'mine' | 'shared' | 'marketplace';

/** The ordered four groups. `label(kind?)` renders "My Data", "All", etc. */
export const SCOPE_GROUPS: { key: ScopeKey; label: (kind?: string) => string }[] = [
  { key: 'all', label: () => 'All' },
  { key: 'mine', label: (kind) => (kind ? `My ${kind}` : 'My') },
  { key: 'shared', label: () => 'Shared' },
  { key: 'marketplace', label: () => 'Marketplace' },
];

/** One place to render a scope's user-facing label. `scopeLabel('mine', 'Data') → "My Data"`. */
export function scopeLabel(key: ScopeKey, kind?: string): string {
  return SCOPE_GROUPS.find((g) => g.key === key)!.label(kind);
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
    mine: all.filter((t) => t.owner === currentUserId),
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

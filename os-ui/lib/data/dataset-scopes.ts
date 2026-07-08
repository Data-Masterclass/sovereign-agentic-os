/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Dataset SCOPE grouping for the unified Datasets view. This is now a thin
 * adapter over the OS-wide `lib/scopes.ts` helper (the single source of truth for
 * the four groups All · My · Shared · Marketplace) — kept as a named module so
 * the Data tab renders "All Data / My Data / Shared Data / Marketplace Data"
 * while every other tab renders the same four groups from the same core.
 *
 * Pure + client-safe: works on the `listDatasets` groups payload (already
 * canView-scoped + tier-grouped server-side); this only re-slices for display.
 */

import {
  type ScopeKey,
  tilesForScope as tilesForScopeCore,
  activeScopeCounts,
  type ScopeGroups as CoreScopeGroups,
  type ScopedTiles,
} from '../scopes.ts';

export type DatasetScope = ScopeKey;

export const DATASET_SCOPES: { key: DatasetScope; label: string }[] = [
  { key: 'all', label: 'All Data' },
  { key: 'mine', label: 'My Data' },
  { key: 'shared', label: 'Shared Data' },
  { key: 'marketplace', label: 'Marketplace Data' },
];

type ScopeTile = { name: string; owner: string; archived?: boolean };
export type ScopeGroups<T extends ScopeTile> = CoreScopeGroups<T>;
export type { ScopedTiles };

/** The tiles one scope shows, split into working list + archived (soft-hidden). */
export function tilesForScope<T extends ScopeTile>(
  groups: ScopeGroups<T>,
  scope: DatasetScope,
  userId: string,
): ScopedTiles<T> {
  return tilesForScopeCore(groups, scope, userId, (t) => t.name);
}

/** Per-scope ACTIVE counts for the switcher labels (archived stays out of counts). */
export function scopeCounts<T extends ScopeTile>(
  groups: ScopeGroups<T>,
  userId: string,
): Record<DatasetScope, number> {
  return activeScopeCounts(groups, userId);
}

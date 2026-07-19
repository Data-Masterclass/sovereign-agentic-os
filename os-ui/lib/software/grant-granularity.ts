/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * GRANT-GRANULARITY helpers — the pure logic behind the Define stage's folder-OR-item
 * grant selection (`components/software/SoftwareContextGrants.tsx`). A FolderTree tick
 * emits a {@link FolderSelection} (whole-folder grants + individual item grants); these
 * helpers reduce that to the flat, backward-compatible item-id ContextGrants shape by
 * EXPANDING each folder grant to the ids of the items under it, then reconciling that
 * target set against the current grants (keeping the access of ids that persist).
 *
 * Kept pure + client-safe (no React / no server imports) so the component and the unit
 * tests share one source of truth — a folder grant means exactly the same set of items
 * everywhere.
 */

import {
  clampContextAccess,
  type ContextAccessCap,
  type ContextGrants,
  type ContextKind,
} from '@/lib/core/context-grants';

/** A minimal item for folder-expansion: its id, folder path, and root scope. */
export type GrantableItem = { id: string; folder: string; scope: 'personal' | 'domain' };

/** A whole-folder grant from FolderTree — a path within a root scope. */
export type FolderGrantRef = { path: string; scope: 'personal' | 'domain' };

/** Is `itemFolder` at or below `folderPath`? Both normalised; `'/'` covers the whole root. */
export function underFolder(folderPath: string, itemFolder: string): boolean {
  if (folderPath === '/' || folderPath === '') return true;
  return itemFolder === folderPath || itemFolder.startsWith(folderPath + '/');
}

/**
 * Expand a FolderTree selection (folder grants + item grants) into the flat set of item
 * ids it covers, over the supplied item list. A folder grant contributes every item under
 * its path in the SAME root scope; item grants pass through. Pure.
 */
export function expandSelectionToIds(
  items: GrantableItem[],
  folderGrants: FolderGrantRef[],
  itemGrants: string[],
): Set<string> {
  const ids = new Set<string>(itemGrants);
  for (const fg of folderGrants) {
    for (const it of items) {
      if (it.scope === fg.scope && underFolder(fg.path, it.folder)) ids.add(it.id);
    }
  }
  return ids;
}

/**
 * Reconcile the granted item set for ONE kind against a target id set: keep ids that
 * persist (with their current access), drop de-selected ones, add new ids at the cap
 * default. Pure — returns a NEW grants object.
 */
export function reconcileGranted(
  grants: ContextGrants,
  kind: ContextKind,
  target: Set<string>,
  cap: ContextAccessCap,
): ContextGrants {
  const current = grants[kind];
  const currentIds = new Set(current.map((g) => g.id));
  const kept = current.filter((g) => target.has(g.id));
  const added = [...target]
    .filter((id) => !currentIds.has(id))
    .map((id) => ({ id, access: clampContextAccess(cap.default, cap) }));
  return { ...grants, [kind]: [...kept, ...added] };
}

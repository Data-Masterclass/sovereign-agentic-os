/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The pure grouping math behind the Organize stage's CategoryTree (lakehouse-expose-
 * experience.md, Phase B). Framework-free so folder assembly + sort + search are unit-
 * testable without React; the `.tsx` skin (CatalogBrowser category mode) reads these and
 * reuses catalog-selection.ts's tri-state `groupState`/`toggleGroupSelection` for the
 * folder checkboxes.
 *
 * The taxonomy is ONE folder level (not a nested FolderTree): folders sorted by count
 * descending, with Unsorted ALWAYS last (an invariant from the design doc), regardless of
 * its count. A table with no placement falls into Unsorted so nothing is ever dropped.
 */

import { keyOf, type TableRef } from './catalog-selection';

export const UNSORTED = 'unsorted';

/** One merged placement the tree reads (mirrors the route's MergedPlacement, UI-side). */
export type Placement = {
  category: string;
  source: 'override' | 'ai' | 'unsorted';
  confidence?: number;
  why?: string;
  model?: string;
};

export type CategoryFolder = {
  id: string;
  name: string;
  tables: TableRef[];
};

/**
 * Assemble the count-sorted folder list for the current taxonomy + placements. Every
 * taxonomy folder appears (even empty, so an admin can move INTO it); an entry pointing at
 * a folder no longer in the taxonomy degrades to Unsorted (honest — the id simply isn't
 * known). Sort: count desc, then name; Unsorted always pinned LAST.
 */
export function buildFolders(
  tables: TableRef[],
  taxonomy: { id: string; name: string }[],
  placements: Record<string, Placement>,
): CategoryFolder[] {
  const known = new Set(taxonomy.map((t) => t.id));
  const nameOf = new Map(taxonomy.map((t) => [t.id, t.name]));
  const byCat = new Map<string, TableRef[]>();
  for (const t of taxonomy) byCat.set(t.id, []); // every folder present, even empty
  if (!byCat.has(UNSORTED)) byCat.set(UNSORTED, []); // Unsorted always exists
  for (const t of tables) {
    const raw = placements[keyOf(t)]?.category ?? UNSORTED;
    const cat = known.has(raw) ? raw : UNSORTED; // unknown id → Unsorted (never invented)
    byCat.get(cat)!.push(t);
  }
  return [...byCat.entries()]
    .map(([id, ts]) => ({ id, name: nameOf.get(id) ?? (id === UNSORTED ? 'Unsorted' : id), tables: ts }))
    .sort((a, b) => {
      if (a.id === UNSORTED) return 1;
      if (b.id === UNSORTED) return -1;
      return b.tables.length - a.tables.length || a.name.localeCompare(b.name);
    });
}

/**
 * Instant client-side filter over the ≤ ~1k rows, matching a table's name, schema, its
 * folder NAME, and the placement's "why" text (design doc: search also matches category
 * names and per-table why text). Empty query → all rows.
 */
export function filterTables(
  tables: TableRef[],
  query: string,
  taxonomy: { id: string; name: string }[],
  placements: Record<string, Placement>,
): TableRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return tables;
  const nameOf = new Map(taxonomy.map((t) => [t.id, t.name.toLowerCase()]));
  return tables.filter((t) => {
    if (t.table.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)) return true;
    const p = placements[keyOf(t)];
    const catName = nameOf.get(p?.category ?? UNSORTED) ?? '';
    if (catName.includes(q)) return true;
    return (p?.why ?? '').toLowerCase().includes(q);
  });
}

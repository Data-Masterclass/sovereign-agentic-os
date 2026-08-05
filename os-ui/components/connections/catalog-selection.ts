/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The pure selection math behind the shared CatalogBrowser (lakehouse-expose-experience.md,
 * Phase A). Framework-free so the tri-state group toggle is unit-testable without React — the
 * `.tsx` component imports these; the parent owns the `Set<'schema.table'>` immutably.
 */

export type TableRef = { schema: string; table: string };

export const keyOf = (t: TableRef): string => `${t.schema}.${t.table}`;

/**
 * Tri-state group toggle: if EVERY table in the group is already selected, clear them all;
 * otherwise (none or some selected) add them all. Returns a fresh Set (never mutates the input).
 * An empty group is a no-op.
 */
export function toggleGroupSelection(selection: ReadonlySet<string>, tables: TableRef[]): Set<string> {
  const keys = tables.map(keyOf);
  const allOn = keys.length > 0 && keys.every((k) => selection.has(k));
  const next = new Set(selection);
  for (const k of keys) { if (allOn) next.delete(k); else next.add(k); }
  return next;
}

/** Group tri-state for the checkbox: 'all' | 'some' | 'none' selected. Empty group → 'none'. */
export function groupState(selection: ReadonlySet<string>, tables: TableRef[]): 'all' | 'some' | 'none' {
  const keys = tables.map(keyOf);
  if (keys.length === 0) return 'none';
  const on = keys.filter((k) => selection.has(k)).length;
  return on === 0 ? 'none' : on === keys.length ? 'all' : 'some';
}

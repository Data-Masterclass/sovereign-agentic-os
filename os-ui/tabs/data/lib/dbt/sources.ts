/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `models/sources.yml` — Bronze landings and federated tables as dbt sources
 * USER STORY: As a data engineer I want every table dbt reads but does not write (the PyIceberg
 *             Bronze landing, another domain's product, a warehouse table a sync copies) declared
 *             as a dbt source, with freshness where the table carries `_loaded_at`.
 * ARCHITECTURE:
 *   - Pure renderer over the planner's `SourceTable` list, grouped by source name, sorted.
 *   - `freshness` only on tables known to carry `_loaded_at` (concept §1) — never a guess.
 */
import { yml } from '@tabs/data/lib/dbt/emit';
import type { SourceTable } from '@tabs/data/lib/dbt/models';

type SourceDoc = {
  name: string;
  database?: string;
  schema: string;
  tables: Record<string, unknown>[];
};

/** Render `models/sources.yml`. Returns null when the project reads no source at all. */
export function renderSources(sources: SourceTable[]): string | null {
  if (sources.length === 0) return null;
  const groups = new Map<string, SourceDoc>();
  for (const s of sources) {
    let g = groups.get(s.source);
    if (!g) {
      g = { name: s.source, ...(s.database ? { database: s.database } : {}), schema: s.schema, tables: [] };
      groups.set(s.source, g);
    }
    g.tables.push({
      name: s.table,
      description: s.description,
      ...(s.loadedAt ? { loaded_at_field: '_loaded_at', freshness: { warn_after: { count: 24, period: 'hour' } } } : {}),
      ...(s.meta ? { meta: s.meta } : {}),
      // Quality rules of a layer built out of band become SOURCE tests (`dbt build` runs them).
      ...(s.columns && s.columns.length ? { columns: s.columns } : {}),
    });
  }
  const docs = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of docs) g.tables.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return yml({ version: 2, sources: docs });
}

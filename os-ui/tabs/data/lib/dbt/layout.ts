/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where the generated dbt project lands in a domain repository (v1 root or v2 data/dbt)
 * USER STORY: As a data engineer I want the dbt project at `data/dbt/` in a migrated repo, so that
 *             `cd data/dbt && dbt parse` works, while a repo that has not been migrated yet keeps
 *             its project at the root and nothing about it changes.
 * ARCHITECTURE:
 *   - PURE. The generator emits project-relative paths; this maps them to repo paths with
 *     `core/infra/repo-layout.ts` and, in v2, adds the layout marker. `os/**` never moves.
 *   - The reverse map serves every reader that sees repo paths (the receive gate, the
 *     engineering view) and must reason about project paths.
 */
import {
  dbtRepoPath, dbtProjectPath, layoutMarker, LAYOUT_MARKER_PATH, LAYOUT_V2, DAGSTER_DIR, KNOWLEDGE_DIR,
  CONNECTIONS_DIR, prefixOf, type LayoutVersion,
} from '@core/infra/repo-layout';

/** In a v2 repo, the folders other writers own that the dbt whole-tree commit must keep. */
export const V2_RESERVED_PREFIXES = [prefixOf(DAGSTER_DIR), prefixOf(KNOWLEDGE_DIR), prefixOf(CONNECTIONS_DIR)];

/** Project-relative file map → repo file map for `layout`. Sorted, like the generator's. */
export function relocateProject(files: Map<string, string>, layout: LayoutVersion): Map<string, string> {
  if (layout !== LAYOUT_V2) return files;
  const out = new Map<string, string>();
  for (const [p, c] of files) out.set(dbtRepoPath(p, layout), c);
  out.set(LAYOUT_MARKER_PATH, layoutMarker());
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A repo path → the dbt-project path a project-relative matcher expects (null: not the project). */
export function projectPathOf(repoPath: string, layout: LayoutVersion): string | null {
  return dbtProjectPath(repoPath, layout);
}

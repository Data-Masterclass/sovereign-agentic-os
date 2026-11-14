/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    This tab's `GitObjectResolver` — "here is how to find THIS dataset in the repo"
 * USER STORY: As a domain member I want a dataset's head commit, history and diff in the drawer
 *             and over the MCP, answered the same way as an agent system's or a dashboard's, so
 *             "everything the OS builds lives in git and can be versioned" is true for the kind
 *             that was in git FIRST (checklist G3/G7, D23/D24).
 * ARCHITECTURE:
 *   - THE CONTRACT FOR STREAM G. `core/infra/git-objects.ts` owns the registry, the generic
 *     `objectGitInfo` / `getVersion` / `diffVersions` reads and the not-found gating; a tab says
 *     only WHERE its object lives and WHETHER the caller may see it. `instrumentation.ts` calls
 *     `registerGitObject('dataset', datasetGitObjectResolver)` at boot.
 *   - VISIBILITY IS THE STORE'S: it resolves through `getDataset(id, user)`, which throws 403 for
 *     a dataset the caller may not see and 404 for one that does not exist. BOTH become `null`,
 *     which G turns into one byte-identical `not_found` — so this read cannot be used to probe
 *     for the existence of another domain's dataset (G5). No second visibility rule here.
 *   - THE PATHS ARE THE DATASET'S OWN MODEL FILES, NOT THE PROJECT. `GIT_OBJECT_LAYOUT`'s
 *     `dataset` row lists the whole generated project because that is what the dbt WRITER commits;
 *     a per-object history may not, or every dataset would inherit every other dataset's commits.
 *     So the selectors are `models/<layer>/<layer>_<slug>.sql` and the personal-lane
 *     `models/personal/<uid>/<layer>_<slug>.sql`, for all three layers and BOTH lanes — a
 *     promotion moves the file, and a history that stopped at the move would hide everything
 *     before it. A selector for a layer that was never built simply matches no commit.
 *   - `schema.yml` is deliberately NOT a selector: one file documents every dataset in its
 *     directory, so including it would attribute a neighbour's change to this dataset.
 *   - KNOWN LIMIT: the planner appends `__<id>` to a model name when two datasets collide on one
 *     slug (the rename edge case), and that file is not matched by the convention above. Such a
 *     dataset's history still resolves through the `OS-Object: <id> (<name>)` trailer, which is
 *     the identity; `via` reports which source answered, so nothing is claimed that was not read.
 */
import 'server-only';
import type { GitObjectLocation } from '@core/infra/git-objects';
import { LAYERS, type Dataset } from '@tabs/data/lib/dataset-schema';
import { physicalSlug, sanitizeIdent } from '@tabs/data/lib/store-fqn';
import { getDataset, type Principal } from '@tabs/data/lib/store';

/** The kind string this tab registers under, in G's `GIT_OBJECT_KINDS`. */
export const GIT_OBJECT_KIND = 'dataset';

/**
 * The repo path selectors for one dataset's generated models — both lanes, every layer. Pure, so
 * the convention is testable without a repository.
 */
export function datasetPaths(d: Pick<Dataset, 'name' | 'owner'> & { slug?: string }): string[] {
  const slug = physicalSlug(d);
  const uid = sanitizeIdent(d.owner);
  const paths: string[] = [];
  for (const layer of LAYERS) {
    paths.push(`models/${layer}/${layer}_${slug}.sql`);
    paths.push(`models/personal/${uid}/${layer}_${slug}.sql`);
  }
  return paths;
}

/**
 * Locate one dataset in its domain's repository, or `null` when the caller cannot see it (which is
 * deliberately the same answer as "it does not exist"). `read` is injected so the gating is
 * testable; the registration passes the store's own governed read.
 */
export function resolveDatasetGitObject(
  user: Principal,
  id: string,
  read: (id: string, user: Principal) => Dataset,
): GitObjectLocation | null {
  let rec: Dataset | null = null;
  try {
    rec = read(id, user);
  } catch {
    // 403 ("not yours") and 404 ("no such dataset") are ONE answer here, by design.
    return null;
  }
  if (!rec || !rec.domain) return null;
  return {
    domain: rec.domain,
    paths: datasetPaths(rec),
    // The dbt commit path writes `OS-Object: <id> (<name>)`, and G matches on the id prefix.
    trailerId: rec.id,
    name: rec.name,
  };
}

/** The resolver `instrumentation.ts` registers for the `dataset` kind. */
export function datasetGitObjectResolver(user: Principal, id: string): GitObjectLocation | null {
  return resolveDatasetGitObject(user, id, (datasetId, principal) => getDataset(datasetId, principal));
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — read a domain's native dashboards (and the dbt YAML they bind to) from git
 * USER STORY: As a viewer I want the dashboard I open drawn from the files committed in my domain's
 *             repository — the dbt saved queries and the Vega-Lite specs — not from a second copy.
 * ARCHITECTURE:
 *   - Server-only. Reads ONE commit (default `main`) through the git store: every dbt property file
 *     under a `models/` tree (v1 root or v2 `data/dbt/`) for the semantic index, and the
 *     `dashboards/**` subtree. Both come from the same sha, so a saved query is always resolved
 *     against the metrics that were committed beside it.
 *   - No fallback: a repo or file the store cannot read is a typed error for the caller to show.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { GitStoreError, commitAt, listTree, readBlob } from '@core/infra/git-store';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { buildSemanticIndex, nativeToSpec, readNativeDashboards, type SemanticIndex } from '@tabs/dashboards/lib/git/native';
import type { DashboardSpec } from '@tabs/dashboards/lib/model';
import type { SnapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';

export type NativeTree = { sha: string; files: Map<string, string>; index: SemanticIndex };

const wanted = (p: string) => p.startsWith(DASHBOARDS_PREFIX) || /(^|\/)models\/.*\.ya?ml$/.test(p);

/** The `dashboards/**` subtree and the dbt YAML of one commit. */
export async function readNativeTree(domain: string, opts: { reposDir?: string; ref?: string } = {}): Promise<NativeTree> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const head = await commitAt(domain, opts.ref ?? 'main', { reposDir });
  if (!head) throw new GitStoreError(`no commit ${opts.ref ?? 'main'} in the repository of '${domain}'`, 404);
  const sha = head.sha;
  const files = new Map<string, string>();
  for (const e of await listTree(domain, sha, { reposDir })) {
    if (wanted(e.path)) files.set(e.path, await readBlob(domain, sha, e.path, { reposDir }));
  }
  return { sha, files, index: buildSemanticIndex(files) };
}

/** Only the dbt YAML of `main` (what the generator needs to bind panels to metrics). */
export async function readSemanticIndex(domain: string, opts: { reposDir?: string } = {}): Promise<SemanticIndex> {
  try {
    return (await readNativeTree(domain, opts)).index;
  } catch (e) {
    // A domain with no repository (or no commit) yet has no dbt metrics: every panel is written as
    // `pending`. Any other failure is thrown — never an empty index standing in for an unread one.
    if (e instanceof GitStoreError && e.status === 404) return buildSemanticIndex(new Map());
    throw e;
  }
}

/** One dashboard read back from the committed native files, with the sha it was read at. */
export async function readNativeDashboard(
  domain: string,
  id: string,
  opts: { reposDir?: string; ref?: string } = {},
): Promise<{ sha: string; dir: string; dashboard: SnapshotDashboard } | null> {
  const tree = await readNativeTree(domain, opts);
  const hit = readNativeDashboards(tree.files, tree.index).find((d) => d.dashboard.id === id);
  return hit ? { sha: tree.sha, ...hit } : null;
}

/**
 * The spec the OS draws for a dashboard's CURRENT version when dashboards are native: read back
 * from the committed files. A dashboard whose native files are not committed (yet) is reported as
 * unavailable, with the reason — the registry copy is never drawn in its place.
 */
export async function nativeSpecForView(
  domain: string,
  id: string,
  opts: { reposDir?: string } = {},
): Promise<{ spec: DashboardSpec; sha: string; dir: string } | { unavailable: string }> {
  let hit;
  try {
    hit = await readNativeDashboard(domain, id, opts);
  } catch (e) {
    return { unavailable: `The dashboard's files could not be read from the ${domain} repository: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!hit) return { unavailable: `The ${domain} repository has no native files for this dashboard yet (dashboards/<slug>/os.yaml). They are written on its next save or the next boot reconcile.` };
  return { spec: nativeToSpec(hit.dashboard), sha: hit.sha, dir: hit.dir };
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — the DRY-RUN migration plan: `os.sovereign/v1 Dashboard` YAML → native files
 * USER STORY: As the owner I want to see, before anything is written, exactly which files each
 *             live dashboard becomes, which panels become dbt saved queries and which stay pending
 *             (and why), so I can decide when to turn `DASHBOARDS_NATIVE` on.
 * ARCHITECTURE:
 *   - PURE: a repo tree in, a plan out. It reads every `dashboards/**\/dashboard.yaml` with the
 *     existing reader (`parseDashboardFile`) and the committed dbt YAML (`buildSemanticIndex`),
 *     and renders the native files with the SAME generator the commit path uses.
 *   - It never writes. The migration itself is the first commit with the flag on (the boot
 *     reconcile regenerates each domain's `dashboards/` subtree in one commit).
 */
import { parseDashboardFile } from '@tabs/dashboards/lib/git/parse';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { buildSemanticIndex, generateNativeDashboardFiles, NATIVE_OS_FILE } from '@tabs/dashboards/lib/git/native';
import { projectSnapshot, type SnapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { load } from 'js-yaml';

export type MigrationPlan = {
  domain: string;
  dashboards: { id: string; name: string; from: string; panels: { id: string; savedQuery?: string; pending?: string }[] }[];
  add: string[];
  modify: string[];
  delete: string[];
  refused: { file: string; reason: string }[];
};

export function planNativeMigration(domain: string, tree: Map<string, string>): MigrationPlan {
  const index = buildSemanticIndex(tree);
  const docs: SnapshotDashboard[] = [];
  const from = new Map<string, string>();
  const refused: MigrationPlan['refused'] = [];
  for (const [p, c] of [...tree.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!p.startsWith(DASHBOARDS_PREFIX) || !p.endsWith('/dashboard.yaml')) continue;
    try {
      const d = parseDashboardFile(c, p);
      docs.push(d);
      from.set(d.id, p);
    } catch (e) {
      refused.push({ file: p, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const next = generateNativeDashboardFiles(projectSnapshot(domain, docs), index);
  const before = [...tree.keys()].filter((p) => p.startsWith(DASHBOARDS_PREFIX));
  const dashboards: MigrationPlan['dashboards'] = [];
  for (const [p, c] of next) {
    if (!p.endsWith(`/${NATIVE_OS_FILE}`)) continue;
    const os = load(c) as { metadata: { id: string; name: string }; spec: { panels: { id: string; savedQuery?: string; pending?: { reason: string } }[] } };
    dashboards.push({
      id: os.metadata.id,
      name: os.metadata.name,
      from: from.get(os.metadata.id) ?? '',
      panels: os.spec.panels.map((x) => ({ id: x.id, ...(x.savedQuery ? { savedQuery: x.savedQuery } : {}), ...(x.pending ? { pending: x.pending.reason } : {}) })),
    });
  }
  return {
    domain,
    dashboards,
    add: [...next.keys()].filter((p) => !tree.has(p)),
    modify: [...next.keys()].filter((p) => tree.has(p) && tree.get(p) !== next.get(p)),
    delete: before.filter((p) => !next.has(p)),
    refused,
  };
}

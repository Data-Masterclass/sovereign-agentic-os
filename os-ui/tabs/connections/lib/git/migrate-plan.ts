/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — the DRY-RUN migration plan for existing live connection records
 * USER STORY: As an operator I want the list of files each domain repository would gain from the
 *             connection records that live only in the store today, and every record that cannot
 *             move with its reason, before anything is written.
 * ARCHITECTURE:
 *   - PURE: reads an operator's read-only export (an array of records, or a `_search` response over
 *     `os-connections`) and returns a plan. It writes nothing and opens no connection. The writer
 *     the plan previews is the SAME generator a save uses (`generateConnectionFiles`), so the plan
 *     cannot drift from what a save would commit.
 *   - A record that cannot render is REFUSED with the generator's own message; it is planned per
 *     record, so one broken connection does not hide its domain's good ones.
 */
import { generateConnectionFiles, type SnapshotConnection } from '@tabs/connections/lib/git/generate';

export type ConnectionsMigrationPlan = {
  mode: 'dry-run';
  domains: { domain: string; files: string[]; catalogs: string[] }[];
  refused: { id: string; domain: string; reason: string }[];
  /** Live non-warehouse connections: not Trino catalogs, so not moved here (dlt sources, WP-18). */
  notCatalogs: string[];
};

/** Records from an export: an array, `{ hits: { hits: [{ _source }] } }`, or an array of hits. */
export function connectionsFromJson(text: string): SnapshotConnection[] {
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { hits?: { hits?: unknown[] } })?.hits?.hits ?? []);
  return list.map((x) => ((x as { _source?: unknown })?._source ?? x) as SnapshotConnection);
}

export function planConnectionsMigration(records: SnapshotConnection[]): ConnectionsMigrationPlan {
  const plan: ConnectionsMigrationPlan = { mode: 'dry-run', domains: [], refused: [], notCatalogs: [] };
  const live = records.filter((r) => r && !r.archived);
  plan.notCatalogs = live.filter((r) => r.template !== 'warehouse' || !r.warehouse).map((r) => r.id).sort();
  const byDomain = new Map<string, SnapshotConnection[]>();
  for (const r of live) {
    if (r.template !== 'warehouse' || !r.warehouse) continue;
    try {
      generateConnectionFiles(r.domain, [r]);
    } catch (e) {
      plan.refused.push({ id: r.id, domain: r.domain, reason: (e as Error).message });
      continue;
    }
    byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
  }
  for (const [domain, recs] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const files = [...generateConnectionFiles(domain, recs).keys()].sort();
      plan.domains.push({ domain, files, catalogs: recs.map((r) => r.warehouse!.catalog).sort() });
    } catch (e) {
      for (const r of recs) plan.refused.push({ id: r.id, domain, reason: (e as Error).message });
    }
  }
  return plan;
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Quality read-back — Dagster asset checks when `DATA_PROJECT_GIT` is on, else the OS ledger
 * USER STORY: As a dataset owner I want the Validate stage, Monitoring and the DQ rollup to show the
 *             results of the dbt tests Dagster actually ran (each dbt test is one asset check), not a
 *             parallel OS ledger (checklist D9) — and "never run" when Dagster has no execution.
 * ARCHITECTURE:
 *   - Flag OFF: `dq-results.ts` exactly as before. Flag ON: `assetChecks` of the dataset's TESTED
 *     asset (the model carrying `schema.yml` tests, or the out-of-band source — `asset-keys.ts`)
 *     mapped into the same `DqRunRecord` shape the surfaces already render, so no UI changes its
 *     contract. `latestDqRuns` is the batch form (one `assetNodes` round trip) for lists.
 *   - Mapping: SUCCEEDED → pass, FAILED → fail with `dagster_dbt/failed_row_count` as violations,
 *     anything else / no execution → not_run. The badge and health score are the same functions the
 *     OS used on its own results (`dq.ts`). Monitors (freshness / volume / schema) are not dbt tests;
 *     with the flag on they are absent, not faked (concept §1).
 *   - The trend is a single point (the latest execution) — Dagster keeps the history; a sparkline
 *     over asset-check executions is B4's read.
 *   - Fallback, labelled not blended: with the flag on, a dataset whose tested asset has NO check
 *     execution yet (a brand-new model, or a layer built out of band) shows the OS's own ad-hoc
 *     "Run checks" row with `source: 'os'`. A record is never a mix of Dagster and OS results, and
 *     a Dagster record always says `source: 'dagster'`.
 */
import 'server-only';
/** The minimum a quality read needs: the dataset id and the domain whose repo holds its models. */
export type DqDataset = { id: string; domain: string };
import { aggregateBadge, healthScore, type CheckResult } from '@tabs/data/lib/dq';
import { ensureHydrated, latestRun, healthTrend, type DqRunRecord } from '@tabs/data/lib/dq-results';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { projectSnapshot, type SnapshotDeps } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import * as dagster from '@core/infra/dagster';

export type DqStatusDeps = SnapshotDeps & {
  dagster?: Pick<typeof dagster, 'assetChecks' | 'allAssetChecks'>;
  flag?: () => boolean;
};

/** One Dagster asset check → the OS's check-result row. */
export function checkToResult(c: dagster.AssetCheck): CheckResult {
  const latest = c.latest;
  if (!latest) return { id: c.name, label: c.name, status: 'not_run', violations: null, reason: 'not executed yet' };
  if (latest.status === 'SUCCEEDED') return { id: c.name, label: c.name, status: 'pass', violations: 0 };
  if (latest.status === 'FAILED') {
    const n = latest.metadata['dagster_dbt/failed_row_count'];
    return { id: c.name, label: c.name, status: 'fail', violations: typeof n === 'number' ? n : null };
  }
  return { id: c.name, label: c.name, status: 'not_run', violations: null, reason: `Dagster check ${latest.status.toLowerCase()}` };
}

/** Dagster checks → the `DqRunRecord` shape every DQ surface renders. Null when no check ever ran. */
export function checksToRecord(d: DqDataset, checks: dagster.AssetCheck[]): DqRunRecord | null {
  const executed = checks.filter((c) => c.latest);
  if (executed.length === 0) return null;
  const results = checks.map(checkToResult);
  const ranAt = executed.map((c) => c.latest!.at ?? '').filter(Boolean).sort().at(-1) ?? new Date(0).toISOString();
  const badge = aggregateBadge(results);
  return {
    id: `${d.id}:${ranAt}`,
    datasetId: d.id,
    ranAt,
    badge,
    healthScore: healthScore(results).score,
    results,
    ranBy: executed.map((c) => c.latest!.runId).find(Boolean) ?? 'dagster',
    domain: d.domain,
    rowCount: null,
    schemaFingerprint: null,
    source: 'dagster',
  };
}

/** The OS's own ad-hoc probe row, labelled — the fallback while no dbt test has run yet. */
function osRow(r: DqRunRecord | null): DqRunRecord | null {
  return r ? { ...r, source: 'os' } : null;
}

/** The latest quality run of one dataset. */
export async function latestDqRun(d: DqDataset, deps: DqStatusDeps = {}): Promise<DqRunRecord | null> {
  await ensureHydrated().catch(() => {});
  if (!(deps.flag ?? dataProjectGitEnabled)()) return latestRun(d.id);
  // Dagster is authoritative with the flag on. While no dbt test has executed for the asset yet,
  // fall back to the OS's own ad-hoc "Run checks" row — LABELLED `source: 'os'`, never blended
  // into a Dagster record.
  if (!d.domain) return osRow(latestRun(d.id));
  const keys = datasetAssetKeys(await projectSnapshot(d.domain, deps), d.id);
  if (!keys.tested) return osRow(latestRun(d.id));
  const r = await (deps.dagster ?? dagster).assetChecks(keys.tested);
  return (r.ok ? checksToRecord(d, r.data) : null) ?? osRow(latestRun(d.id));
}

/** The health trend: the ledger's series, or (flag on) the single latest Dagster execution. */
export async function dqTrend(d: DqDataset, deps: DqStatusDeps = {}): Promise<{ ranAt: string; score: number | null; badge: DqRunRecord['badge'] }[]> {
  await ensureHydrated().catch(() => {});
  if (!(deps.flag ?? dataProjectGitEnabled)()) return healthTrend(d.id);
  const last = await latestDqRun(d, deps);
  // Dagster keeps the history of check executions; the OS shows the latest point (a sparkline over
  // `assetCheckExecutions` is B4's read). A fallback OS row keeps that series instead.
  if (last?.source === 'os') return healthTrend(d.id);
  return last ? [{ ranAt: last.ranAt, score: last.healthScore, badge: last.badge }] : [];
}

/** Latest quality run for many datasets at once (one Dagster round trip when the flag is on). */
export async function latestDqRuns(datasets: DqDataset[], deps: DqStatusDeps = {}): Promise<Map<string, DqRunRecord | null>> {
  const out = new Map<string, DqRunRecord | null>();
  await ensureHydrated().catch(() => {});
  if (!(deps.flag ?? dataProjectGitEnabled)()) {
    for (const d of datasets) out.set(d.id, latestRun(d.id));
    return out;
  }
  for (const d of datasets) out.set(d.id, osRow(latestRun(d.id)));
  const all = await (deps.dagster ?? dagster).allAssetChecks();
  if (!all.ok) return out;
  const byDomain = new Map<string, DqDataset[]>();
  for (const d of datasets) if (d.domain) byDomain.set(d.domain, [...(byDomain.get(d.domain) ?? []), d]);
  for (const [domain, ds] of byDomain) {
    const snapshot = await projectSnapshot(domain, deps);
    for (const d of ds) {
      const keys = datasetAssetKeys(snapshot, d.id);
      if (!keys.tested) continue;
      const rec = checksToRecord(d, all.data[keys.tested.join('/')] ?? []);
      if (rec) out.set(d.id, rec);
    }
  }
  return out;
}

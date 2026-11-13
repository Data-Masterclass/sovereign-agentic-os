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
 *   - THE OWNER IS TOLD (B4-review L-2). `/api/data/dq/run-all` was the only caller of
 *     `deliverDqAlert`, and B4 deleted it, so a new failure notified nobody (deviation B4-9). The
 *     alert now fires from THIS read-back: when a Dagster record transitions INTO `failing`
 *     (`isNewFailure`) and that execution has not already been alerted (`dq-alert-state.ts`, a
 *     durable per-dataset record keyed on `ranAt`), the dataset owner gets one in-app
 *     notification. Fire-and-forget and fail-soft: an alert that cannot be delivered never changes
 *     what the read returns.
 *   - Fallback, labelled not blended: with the flag on, a dataset whose tested asset has NO check
 *     execution yet (a brand-new model, or a layer built out of band) shows the OS's own ad-hoc
 *     "Run checks" row with `source: 'os'`. A record is never a mix of Dagster and OS results, and
 *     a Dagster record always says `source: 'dagster'`.
 */
import 'server-only';
import { aggregateBadge, dqSourceLabel, healthScore, type CheckResult } from '@tabs/data/lib/dq';

/** Re-exported so a consumer of this read-back ALSO gets the wording for `DqRunRecord.source`
 *  without a second cross-tab import (review B2-review-M5). */
export { dqSourceLabel };
import { ensureHydrated, latestRun, healthTrend, type DqRunRecord } from '@tabs/data/lib/dq-results';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import { projectSnapshot, type SnapshotDeps } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import * as dagster from '@core/infra/dagster';
import { deliverDqAlert } from '@core/notifications/dq-alert';
import { isNewFailure } from '@tabs/data/lib/dq-run-server';
import { dqAlertRecord, ensureDqAlertsHydrated, putDqAlertRecord } from '@tabs/data/lib/dq-alert-state';

/** The minimum a quality read needs: the dataset id and the domain whose repo holds its models. */
export type DqDataset = { id: string; domain: string };

export type DqStatusDeps = SnapshotDeps & {
  dagster?: Pick<typeof dagster, 'assetChecks' | 'allAssetChecks'>;
  flag?: () => boolean;
  /** The alert delivery (tests inject a spy). Default: the in-app notification boundary. */
  alert?: typeof deliverDqAlert;
  /** Resolve a dataset's owner + display name (tests inject). Default: the Data tab's store. */
  ownerOf?: (datasetId: string) => Promise<{ owner: string; name: string } | null>;
  now?: () => string;
};

/** The dataset's owner and name, from this tab's own store. Null when it cannot be resolved. */
async function ownerFromStore(datasetId: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { listAllDatasets } = await import('@tabs/data/lib/store');
    const d = listAllDatasets().find((x) => x.id === datasetId);
    return d && d.owner ? { owner: d.owner, name: d.name ?? datasetId } : null;
  } catch {
    return null;
  }
}

/**
 * Tell the owner, ONCE, when a Dagster record transitions into `failing`. Never throws, never
 * changes the caller's value, and never alerts twice for the same check execution.
 *
 * Only a `dagster` record alerts: the OS's own ad-hoc probe is something a person just pressed and
 * is reading the result of, so a notification about it is noise.
 */
export async function alertOnNewFailure(record: DqRunRecord | null, deps: DqStatusDeps = {}): Promise<'alerted' | 'suppressed' | 'skipped'> {
  if (!record || record.source !== 'dagster') return 'skipped';
  try {
    await ensureDqAlertsHydrated();
    const prior = dqAlertRecord(record.datasetId);
    const seenThisRun = prior?.lastRanAt === record.ranAt;
    const fresh = isNewFailure(record.badge, prior?.lastBadge ?? null);
    const nowIso = (deps.now ?? (() => new Date().toISOString()))();
    if (!fresh || seenThisRun) {
      // Still record what we saw, so a recovery resets the transition and the next failure fires.
      if (!seenThisRun) {
        putDqAlertRecord({ datasetId: record.datasetId, lastBadge: record.badge, lastRanAt: record.ranAt, ...(prior?.lastAlertedAt ? { lastAlertedAt: prior.lastAlertedAt } : {}) });
      }
      return 'suppressed';
    }
    const who = await (deps.ownerOf ?? ownerFromStore)(record.datasetId);
    if (!who) {
      // No resolvable owner ⇒ nobody to tell. Record the badge anyway so the transition is not
      // replayed forever, and say so in the log.
      console.warn(`[dq-alert] ${record.datasetId} failed its checks but has no resolvable owner — nobody was notified`);
      putDqAlertRecord({ datasetId: record.datasetId, lastBadge: record.badge, lastRanAt: record.ranAt });
      return 'skipped';
    }
    const failing = record.results.filter((r) => r.status === 'fail').map((r) => r.label);
    (deps.alert ?? deliverDqAlert)(
      { datasetName: who.name, healthScore: record.healthScore, failingLabels: failing },
      { userId: who.owner },
    );
    putDqAlertRecord({ datasetId: record.datasetId, lastBadge: record.badge, lastRanAt: record.ranAt, lastAlertedAt: nowIso });
    return 'alerted';
  } catch (e) {
    console.warn(`[dq-alert] could not evaluate the quality alert for ${record.datasetId}: ${e instanceof Error ? e.message : String(e)}`);
    return 'skipped';
  }
}

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
  const record = (r.ok ? checksToRecord(d, r.data) : null) ?? osRow(latestRun(d.id));
  await alertOnNewFailure(record, deps);
  return record;
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
      if (rec) {
        out.set(d.id, rec);
        await alertOnNewFailure(rec, deps);
      }
    }
  }
  return out;
}

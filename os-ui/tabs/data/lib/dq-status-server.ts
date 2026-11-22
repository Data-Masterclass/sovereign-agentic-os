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
 *   - NO SILENT FALLBACK ON AN OUTAGE. When Dagster cannot be read (`assetChecks` / `allAssetChecks`
 *     not ok) the record is `source: 'unavailable'` with the reason: badge unknown, no score, no rule
 *     rows. The OS ledger's last row is carried only as `unavailable.lastKnown` with its own time, so
 *     a surface can say "last known <time>"; it is never shown as the current result, never drawn as
 *     the trend, and never alerts. The fallback above is only for "Dagster answered, nothing ran yet".
 *   - The periodic read-back logs an unreadable Dagster and raises the `dq-readback` health warning
 *     (`/api/status` `storeWarnings`) until a later pass reads it again.
 *   - ONE POD ALERTS: the alert is gated by a create-only claim per (dataset, rule, ranAt) on the
 *     shared store (`dq-alert-state.ts`), so several os-ui replicas send a given alert once.
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
import { dqAlertRecord, ensureDqAlertsHydrated, putDqAlertRecord, freshDqAlertRecord, claimDqAlert, type DqAlertClaim } from '@tabs/data/lib/dq-alert-state';
import { setHealthWarning, clearHealthWarning, getHealthWarning } from '@core/infra/health-warnings';

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
  /** The tested asset key of a dataset (tests inject). Default: from the domain's dbt project snapshot. */
  testedAsset?: (d: DqDataset) => Promise<string[] | null>;
  /** The shared compare-and-set that decides which pod sends an alert (tests inject). */
  claim?: (k: DqAlertClaim) => Promise<'won' | 'lost' | 'unreachable'>;
};

/** The name under which the periodic read-back raises its health warning. */
const READBACK_WARNING = 'dq-readback';

/** The read-back's own unavailability, or null when its last pass reached Dagster. */
export function readbackWarning(): string | null {
  return getHealthWarning(READBACK_WARNING);
}

async function testedAssetOf(d: DqDataset, deps: DqStatusDeps): Promise<string[] | null> {
  if (deps.testedAsset) return deps.testedAsset(d);
  return datasetAssetKeys(await projectSnapshot(d.domain, deps), d.id).tested;
}

/**
 * Dagster could not be read: there is NO current result. The OS ledger's last row rides along only as
 * `lastKnown` (with its own time) — it is never `results`, never a badge, never a score.
 */
function unavailableRecord(d: DqDataset, reason: string): DqRunRecord {
  const last = latestRun(d.id);
  return {
    id: `${d.id}:unavailable`,
    datasetId: d.id,
    ranAt: new Date(0).toISOString(),
    badge: 'unknown',
    healthScore: null,
    results: [],
    ranBy: 'dagster',
    domain: d.domain,
    rowCount: null,
    schemaFingerprint: null,
    source: 'unavailable',
    unavailable: { reason: `Dagster: ${reason}`, lastKnown: last ? { ranAt: last.ranAt, badge: last.badge, healthScore: last.healthScore } : null },
  };
}

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
    // Re-read the shared record: this pod hydrated once, another pod may have seen newer runs since.
    const prior = await freshDqAlertRecord(record.datasetId);
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
    // WHICH POD SENDS: one compare-and-set per failing rule on the shared store. The pod that wins a
    // rule's claim reports that rule; a pod that loses it knows another replica already did.
    const claim = deps.claim ?? claimDqAlert;
    const failing = record.results.filter((r) => r.status === 'fail');
    const outcomes = await Promise.all(failing.map(async (r) => ({ r, o: await claim({ datasetId: record.datasetId, rule: r.id, ranAt: record.ranAt }) })));
    const won = outcomes.filter((x) => x.o === 'won').map((x) => x.r.label);
    const unreachable = outcomes.some((x) => x.o === 'unreachable');
    if (won.length > 0) {
      (deps.alert ?? deliverDqAlert)(
        { datasetName: who.name, healthScore: record.healthScore, failingLabels: won },
        { userId: who.owner },
      );
    }
    if (unreachable) {
      // The claim store could not answer for some rule. Send nothing for it and do NOT mark the run
      // seen: the next read retries it (rules already claimed stay claimed, so nothing repeats).
      console.warn(`[dq-alert] ${record.datasetId}: the alert claim store was unreachable — will retry on the next read`);
      return won.length > 0 ? 'alerted' : 'skipped';
    }
    putDqAlertRecord({ datasetId: record.datasetId, lastBadge: record.badge, lastRanAt: record.ranAt, ...(won.length > 0 ? { lastAlertedAt: nowIso } : prior?.lastAlertedAt ? { lastAlertedAt: prior.lastAlertedAt } : {}) });
    return won.length > 0 ? 'alerted' : 'suppressed';
  } catch (e) {
    console.warn(`[dq-alert] could not evaluate the quality alert for ${record.datasetId}: ${e instanceof Error ? e.message : String(e)}`);
    return 'skipped';
  }
}

/** One Dagster asset check → the OS's check-result row. */
export function checkToResult(c: dagster.AssetCheck): CheckResult {
  const latest = c.latest;
  if (!latest) return { id: c.name, label: c.name, status: 'not_run', violations: null, reason: 'not executed yet' };
  const at = latest.at ? { at: latest.at } : {};
  if (latest.status === 'SUCCEEDED') return { id: c.name, label: c.name, status: 'pass', violations: 0, ...at };
  if (latest.status === 'FAILED') {
    const n = latest.metadata['dagster_dbt/failed_row_count'];
    // dbt's own severity decides: a `severity: warn` test is Dagster's FAILED with severity WARN.
    const warn = latest.severity === 'WARN';
    return { id: c.name, label: c.name, status: warn ? 'warn' : 'fail', violations: typeof n === 'number' ? n : null, ...(latest.severity ? { severity: warn ? 'warn' as const : 'error' as const } : {}), ...at };
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
  const tested = await testedAssetOf(d, deps);
  if (!tested) return osRow(latestRun(d.id));
  const r = await (deps.dagster ?? dagster).assetChecks(tested);
  // Dagster unreachable ⇒ UNAVAILABLE with the reason. The ledger row is not a stand-in for it.
  if (!r.ok) return unavailableRecord(d, r.error);
  const record = checksToRecord(d, r.data) ?? osRow(latestRun(d.id));
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
  if (last?.source === 'unavailable') return [];
  return last ? [{ ranAt: last.ranAt, score: last.healthScore, badge: last.badge }] : [];
}

/** The batch read without the owner alert (the alert is `alertOnNewFailure`'s, applied by the caller). */
export async function readDqRuns(datasets: DqDataset[], deps: DqStatusDeps = {}): Promise<Map<string, DqRunRecord | null>> {
  const out = new Map<string, DqRunRecord | null>();
  await ensureHydrated().catch(() => {});
  if (!(deps.flag ?? dataProjectGitEnabled)()) {
    for (const d of datasets) out.set(d.id, latestRun(d.id));
    return out;
  }
  for (const d of datasets) out.set(d.id, osRow(latestRun(d.id)));
  const all = await (deps.dagster ?? dagster).allAssetChecks();
  const byDomain = new Map<string, DqDataset[]>();
  for (const d of datasets) if (d.domain) byDomain.set(d.domain, [...(byDomain.get(d.domain) ?? []), d]);
  for (const [domain, ds] of byDomain) {
    const snapshot = deps.testedAsset ? null : await projectSnapshot(domain, deps);
    for (const d of ds) {
      const tested = snapshot ? datasetAssetKeys(snapshot, d.id).tested : await testedAssetOf(d, deps);
      if (!tested) continue;
      // Dagster unreachable ⇒ a dataset that HAS a tested asset is unavailable, not its ledger row.
      if (!all.ok) { out.set(d.id, unavailableRecord(d, all.error)); continue; }
      const rec = checksToRecord(d, all.data[tested.join('/')] ?? []);
      if (rec) out.set(d.id, rec);
    }
  }
  return out;
}

/** Latest quality run for many datasets at once (one Dagster round trip when the flag is on). */
export async function latestDqRuns(datasets: DqDataset[], deps: DqStatusDeps = {}): Promise<Map<string, DqRunRecord | null>> {
  const out = await readDqRuns(datasets, deps);
  for (const rec of out.values()) await alertOnNewFailure(rec, deps);
  return out;
}

/**
 * The periodic read-back: the scheduled Dagster run evaluates the dbt tests, and this tells each
 * owner once when a run turned a dataset failing, whether or not anyone opened a page. It reads
 * Dagster's check executions; it evaluates nothing itself.
 */
export async function readbackAllDq(datasets: DqDataset[], deps: DqStatusDeps & { latestRuns?: typeof readDqRuns } = {}): Promise<{ read: number; alerted: number; unavailable: number }> {
  let runs: Map<string, DqRunRecord | null>;
  try {
    runs = await (deps.latestRuns ?? readDqRuns)(datasets, deps);
  } catch (e) {
    const msg = `[dq-readback] the periodic quality read-back failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(msg);
    setHealthWarning(READBACK_WARNING, msg);
    throw e;
  }
  const down = [...runs.values()].filter((r): r is DqRunRecord => r?.source === 'unavailable');
  if (down.length > 0) {
    // Not "nothing failed": nobody could look. Say so in the log and on /api/status.
    const msg = `[dq-readback] Dagster check results are unavailable for ${down.length} dataset(s) — no failing run can be detected until it answers (${down[0].unavailable!.reason})`;
    console.warn(msg);
    setHealthWarning(READBACK_WARNING, msg);
  } else {
    clearHealthWarning(READBACK_WARNING);
  }
  let alerted = 0;
  for (const rec of runs.values()) if ((await alertOnNewFailure(rec, deps)) === 'alerted') alerted++;
  return { read: runs.size, alerted, unavailable: down.length };
}

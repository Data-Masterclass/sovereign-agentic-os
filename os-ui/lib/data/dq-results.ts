/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '../infra/os-mirror.ts';
import type { CheckResult, QualityBadge } from './dq.ts';

/**
 * Durable DATA-QUALITY RESULTS store — a time-series of governed check runs, one row
 * per run per dataset. It mirrors the alert-store pattern (osMirror write-through +
 * global-symbol in-process cache + `os-dq-results` OpenSearch index), the same
 * artifact-safe durability every other OS store uses, so a health score + trend
 * survive a pod roll instead of vanishing with the request.
 *
 * Each governed run (`dq-run.ts`, invoked by the checks route) APPENDS a record:
 *   { id, datasetId, ranAt, badge, healthScore, results[], ranBy, domain }
 * The store keeps the most recent {@link MAX_RUNS_PER_DATASET} per dataset in-process
 * (older rows stay in the mirror but aren't hydrated back — the trend only needs the
 * recent window). Reads are honest: no run yet ⇒ empty list ⇒ the stage shows
 * "not run", never a fabricated pass.
 *
 * Pure of Next imports beyond `server-only` (only osMirror + config-free helpers) so
 * the append/trim/trend logic is directly unit-tested with a fake mirror.
 *
 * DEFERRED (see docs/research/data-quality-plan.md): a scheduled DQ CronJob that writes
 * these rows on a cadence + fires alerts on new failure; this store is the substrate.
 */

export type DqRunRecord = {
  /** `${datasetId}:${ranAt}` — unique, sortable, one per run. */
  id: string;
  datasetId: string;
  ranAt: string;
  badge: QualityBadge;
  /** 0–100, or null when nothing ran (honest — never a fake 100). */
  healthScore: number | null;
  results: CheckResult[];
  /** Who ran it (audit) and the domain the dataset belongs to (scope). */
  ranBy: string;
  domain: string;
};

/** How many recent runs per dataset we keep hydrated for the trend sparkline. */
export const MAX_RUNS_PER_DATASET = 30;

const DQ_RESULTS_KEY = Symbol.for('soa.data.dq-results.store');

type DqStoreState = { runs: Map<string, DqRunRecord>; hydration: Promise<void> | null };

function dqStoreState(): DqStoreState {
  const g = globalThis as unknown as Record<symbol, DqStoreState | undefined>;
  if (!g[DQ_RESULTS_KEY]) g[DQ_RESULTS_KEY] = { runs: new Map(), hydration: null };
  return g[DQ_RESULTS_KEY]!;
}

const mirror = osMirror({
  index: 'os-dq-results',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        datasetId: { type: 'keyword' },
        ranAt: { type: 'date' },
        badge: { type: 'keyword' },
        healthScore: { type: 'integer' },
        ranBy: { type: 'keyword' },
        domain: { type: 'keyword' },
      },
    },
  },
});

export async function ensureHydrated(): Promise<void> {
  const s = dqStoreState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = dqStoreState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as DqRunRecord[]) {
    if (rec.id && rec.datasetId) s.runs.set(rec.id, rec);
  }
  // Keep only the recent window per dataset in-process after a hydrate.
  trimAll(s);
}

/** Chronological (oldest→newest) runs for one dataset, in-process. */
function runsFor(s: DqStoreState, datasetId: string): DqRunRecord[] {
  return Array.from(s.runs.values())
    .filter((r) => r.datasetId === datasetId)
    .sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}

function trimDataset(s: DqStoreState, datasetId: string): void {
  const runs = runsFor(s, datasetId);
  const excess = runs.length - MAX_RUNS_PER_DATASET;
  for (let i = 0; i < excess; i++) s.runs.delete(runs[i].id);
}

function trimAll(s: DqStoreState): void {
  const ids = new Set(Array.from(s.runs.values()).map((r) => r.datasetId));
  for (const id of ids) trimDataset(s, id);
}

/**
 * Append ONE governed run to the time-series (write-through to the mirror). `ranAt`
 * comes from the run itself; a collision on the same millisecond is disambiguated so
 * two runs never overwrite. Returns the stored record.
 */
export function recordRun(input: {
  datasetId: string;
  ranAt: string;
  badge: QualityBadge;
  healthScore: number | null;
  results: CheckResult[];
  ranBy: string;
  domain?: string;
}): DqRunRecord {
  const s = dqStoreState();
  let id = `${input.datasetId}:${input.ranAt}`;
  // Disambiguate a same-millisecond re-run so the append never clobbers a prior row.
  let salt = 1;
  while (s.runs.has(id)) id = `${input.datasetId}:${input.ranAt}#${salt++}`;
  const rec: DqRunRecord = {
    id,
    datasetId: input.datasetId,
    ranAt: input.ranAt,
    badge: input.badge,
    healthScore: input.healthScore,
    results: input.results,
    ranBy: input.ranBy,
    domain: input.domain ?? 'default',
  };
  s.runs.set(id, rec);
  trimDataset(s, input.datasetId);
  mirror.writeThrough(id, rec);
  return rec;
}

/** All retained runs for a dataset, oldest→newest (for the trend sparkline). */
export function listRuns(datasetId: string): DqRunRecord[] {
  return runsFor(dqStoreState(), datasetId);
}

/** The most recent run for a dataset, or null when it has never been run. */
export function latestRun(datasetId: string): DqRunRecord | null {
  const runs = runsFor(dqStoreState(), datasetId);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/**
 * The health-score trend (oldest→newest), one point per run. Runs where nothing ran
 * (score null) are INCLUDED as null so the sparkline shows an honest gap, not a fake 0.
 */
export function healthTrend(datasetId: string): { ranAt: string; score: number | null; badge: QualityBadge }[] {
  return listRuns(datasetId).map((r) => ({ ranAt: r.ranAt, score: r.healthScore, badge: r.badge }));
}

/** For tests only — reset in-process state without touching the mirror. */
export function __resetDqResults(): void {
  const g = globalThis as unknown as Record<symbol, DqStoreState | undefined>;
  g[DQ_RESULTS_KEY] = { runs: new Map(), hydration: null };
}

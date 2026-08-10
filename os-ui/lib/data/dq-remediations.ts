/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '../infra/os-mirror.ts';

/**
 * DURABLE REMEDIATION RUNS — the audit time-series for applied DQ fixes (Data tab ·
 * Validate · AI-proposed remediations). One record per governed fix-MERGE, mirroring
 * the dq-results store pattern (in-process map + osMirror write-through), so "what
 * changed my data, when, by whom, and how do I undo it" always has an answer:
 *
 *   - `batchId`          — the remediation batch id stamped on the run (sliceBatchId
 *                          mint, same lineage discipline as the sync engine);
 *   - `snapshotIdBefore` — the Iceberg snapshot id read BEFORE the MERGE. The execute
 *                          path has NO governed rollback shape (delete-by-batch only
 *                          un-lands appends; it cannot undo an in-place MERGE), so
 *                          revert is surfaced HONESTLY as "via Console" with this id;
 *   - `violationsAfter`  — the REAL re-check result after apply (a fix that didn't
 *                          fix stays red — never inferred from rowsChanged).
 */

export type RemediationRecord = {
  /** `${datasetId}:${checkId}:${ranAt}` — unique, sortable. */
  id: string;
  datasetId: string;
  checkId: string;
  ruleLabel: string;
  ranAt: string;
  ranBy: string;
  domain: string;
  mode: 'batch' | 'rows';
  /** batch mode: the validated expression that was applied. */
  sqlExpr?: string;
  /** rows mode: how many row fixes were applied. */
  rowsFixed?: number;
  rowsChanged: number | null;
  violationsBefore: number;
  /** Re-check after apply — null only when the re-check itself could not run. */
  violationsAfter: number | null;
  batchId: string;
  snapshotIdBefore: string | null;
  fqn: string;
  layer: string;
};

/** Retained window per dataset (mirrors MAX_RUNS_PER_DATASET in dq-results). */
export const MAX_REMEDIATIONS_PER_DATASET = 50;

const KEY = Symbol.for('soa.data.dq-remediations.store');

type State = { runs: Map<string, RemediationRecord>; hydration: Promise<void> | null };

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { runs: new Map(), hydration: null };
  return g[KEY]!;
}

const mirror = osMirror({
  index: 'os-dq-remediations',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        datasetId: { type: 'keyword' },
        checkId: { type: 'keyword' },
        ranAt: { type: 'date' },
        ranBy: { type: 'keyword' },
        domain: { type: 'keyword' },
        mode: { type: 'keyword' },
        rowsChanged: { type: 'long' },
        violationsBefore: { type: 'long' },
        violationsAfter: { type: 'long' },
        batchId: { type: 'keyword' },
        snapshotIdBefore: { type: 'keyword' },
        fqn: { type: 'keyword' },
        layer: { type: 'keyword' },
      },
    },
  },
});

export async function ensureRemediationsHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as RemediationRecord[]) {
    if (rec.id && rec.datasetId) s.runs.set(rec.id, rec);
  }
  trimAll(s);
}

function runsFor(s: State, datasetId: string): RemediationRecord[] {
  return Array.from(s.runs.values())
    .filter((r) => r.datasetId === datasetId)
    .sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}

function trimDataset(s: State, datasetId: string): void {
  const runs = runsFor(s, datasetId);
  const excess = runs.length - MAX_REMEDIATIONS_PER_DATASET;
  for (let i = 0; i < excess; i++) s.runs.delete(runs[i].id);
}

function trimAll(s: State): void {
  const ids = new Set(Array.from(s.runs.values()).map((r) => r.datasetId));
  for (const id of ids) trimDataset(s, id);
}

/** Append ONE applied remediation (write-through). Same-millisecond collisions are
 *  disambiguated so an append never clobbers a prior record. */
export function recordRemediation(input: Omit<RemediationRecord, 'id'>): RemediationRecord {
  const s = state();
  let id = `${input.datasetId}:${input.checkId}:${input.ranAt}`;
  let salt = 1;
  while (s.runs.has(id)) id = `${input.datasetId}:${input.checkId}:${input.ranAt}#${salt++}`;
  const rec: RemediationRecord = { id, ...input };
  s.runs.set(id, rec);
  trimDataset(s, input.datasetId);
  mirror.writeThrough(id, rec);
  return rec;
}

/** The most recent remediation for one rule, or null. */
export function latestRemediation(datasetId: string, checkId: string): RemediationRecord | null {
  const runs = runsFor(state(), datasetId).filter((r) => r.checkId === checkId);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** For tests only — reset in-process state without touching the mirror. */
export function __resetRemediations(): void {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  g[KEY] = { runs: new Map(), hydration: null };
}

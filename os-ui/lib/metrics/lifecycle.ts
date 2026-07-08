/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Measure } from '../data/dataset-schema.ts';
import {
  type Principal,
  getDataset,
  defineMeasure,
  removeMeasure,
  requireDatasetEditable,
} from '../data/store.ts';
import { MetricError } from './model.ts';
import { osMirror } from '../os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../versioning.ts';
import {
  type PhysicalDeleteReport,
  deregisterCubeMembers,
} from './physical-delete.ts';

/**
 * Metric LIFECYCLE — the archive → delete/restore + version-history discipline every
 * other artifact tab already has, brought to Metrics (which had NONE). A metric is a
 * measure on a governed dataset, so the base measure lives in `lib/data/store` (single
 * write, no drift). This module adds the lifecycle OVERLAY that a measure alone can't
 * carry:
 *
 *   • ARCHIVE — a reversible soft-hide flag keyed by metric id (`datasetId.measure`).
 *     Archive KEEPS the measure (and thus its Cube model member) — a governance hide,
 *     not a physical removal — so an archived metric restores instantly.
 *   • VERSIONS — per-metric history (the reused `versionLog`); the measure is snapshotted
 *     before a destructive op so a delete/restore can itself be undone.
 *   • DELETE — PHYSICAL: de-register the Cube measure via `lib/metrics/physical-delete`
 *     (the injected `removeMeasure` drops it from `/api/cube/models`), snapshot it for
 *     restore, then forget the archive flag. Honest `{ recordDeleted, physical[] }` report.
 *
 * Same shape + durability as the other stores: an authoritative in-process flag map, a
 * best-effort os-mirror, `__resetLifecycle` for tests. Edit authority is the SAME gate
 * as the base measure (owner or domain admin) — enforced by `getDataset`/`removeMeasure`
 * throwing 403 for a caller who may not edit, so nothing is hidden or dropped for them.
 */

function now(): string {
  return new Date().toISOString();
}

function splitId(metricId: string): { datasetId: string; measure: string } {
  const lastDot = metricId.lastIndexOf('.');
  if (lastDot <= 0) throw new MetricError(`invalid metric id '${metricId}'`, 400);
  return { datasetId: metricId.slice(0, lastDot), measure: metricId.slice(lastDot + 1) };
}

// --------------------------------------------------- archive-flag overlay state --
type ArchiveFlag = { id: string; datasetId: string; measure: string; archived: boolean; updatedAt: string };
type LifecycleState = { flags: Map<string, ArchiveFlag>; hydration: Promise<void> | null };
const LC_KEY = Symbol.for('soa.metrics.lifecycle');
function lc(): LifecycleState {
  const g = globalThis as unknown as Record<symbol, LifecycleState | undefined>;
  if (!g[LC_KEY]) g[LC_KEY] = { flags: new Map(), hydration: null };
  return g[LC_KEY]!;
}

const mirror = osMirror({
  index: 'os-metric-lifecycle',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        datasetId: { type: 'keyword' },
        measure: { type: 'keyword' },
        archived: { type: 'boolean' },
        updatedAt: { type: 'date' },
      },
    },
  },
});

// Per-metric version history — the reused OS helper. The snapshot is the Measure, so a
// deleted metric can be restored by re-defining exactly the measure that was dropped.
const versions = versionLog('metric');

export async function ensureHydrated(): Promise<void> {
  const s = lc();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = lc();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const f of docs as ArchiveFlag[]) {
    if (f && f.id && !s.flags.has(f.id)) s.flags.set(f.id, f);
  }
}

export function __resetLifecycle(): void {
  const s = lc();
  s.flags.clear();
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
}

/** Whether a metric is archived (soft-hidden). Default false. */
export function isMetricArchived(metricId: string): boolean {
  return lc().flags.get(metricId)?.archived ?? false;
}

function setFlag(metricId: string, archived: boolean): void {
  const { datasetId, measure } = splitId(metricId);
  const flag: ArchiveFlag = { id: metricId, datasetId, measure, archived, updatedAt: now() };
  lc().flags.set(metricId, flag);
  mirror.writeThrough(metricId, flag);
}

/** Resolve the current measure for a metric id, EDIT-scoped (owner or domain admin). */
function requireMeasure(metricId: string, user: Principal): { datasetId: string; measure: Measure } {
  const { datasetId, measure } = splitId(metricId);
  const d = requireDatasetEditable(datasetId, user); // throws 403/404 → nothing hidden/dropped
  const m = d.measures.find((x) => x.name === measure);
  if (!m) throw new MetricError(`metric '${metricId}' not found`, 404);
  return { datasetId, measure: m };
}

/** Prove edit authority on the metric's dataset WITHOUT requiring the measure to still
 *  exist — history + restore stay reachable AFTER a delete removed the measure. */
function requireDatasetEdit(metricId: string, user: Principal): string {
  const { datasetId } = splitId(metricId);
  requireDatasetEditable(datasetId, user); // throws 403/404 → nothing is listed/restored
  return datasetId;
}

/**
 * ARCHIVE a metric: a reversible soft-hide. The measure (and its Cube model member) are
 * KEPT — this only flips the lifecycle flag. Edit-scoped (getDataset re-checks canEdit).
 */
export function archiveMetric(metricId: string, user: Principal): { id: string; archived: true } {
  requireMeasure(metricId, user); // authorize + prove it exists
  setFlag(metricId, true);
  return { id: metricId, archived: true };
}

/** UNARCHIVE a metric back into the working lists (edit-scoped). */
export function unarchiveMetric(metricId: string, user: Principal): { id: string; archived: false } {
  requireMeasure(metricId, user);
  setFlag(metricId, false);
  return { id: metricId, archived: false };
}

/** Version history for a metric, newest first (edit-scoped). Reachable AFTER a delete
 *  removed the measure — history + restore don't require the measure to still exist. */
export function listMetricVersions(metricId: string, user: Principal): ArtifactVersion[] {
  requireDatasetEdit(metricId, user);
  return versions.list(metricId);
}

/**
 * DELETE a metric — PHYSICAL. Snapshot the measure first (so the delete is restorable),
 * then de-register it from its Cube model via the injected `removeMeasure` (drops it from
 * `/api/cube/models` → stops being queryable), then forget the archive flag. Returns an
 * honest report: `recordDeleted` (the lifecycle flag/registry side) + `physical[]` (the
 * Cube de-registration outcome, honest when the measure was already absent). Edit-scoped.
 */
export function deleteMetric(metricId: string, user: Principal): PhysicalDeleteReport {
  const { datasetId, measure } = requireMeasure(metricId, user);
  // Snapshot the measure so restore can re-define exactly what was dropped.
  versions.record(metricId, user.id, { measure }, 'delete metric');
  const d = getDataset(datasetId, user);
  const physical = deregisterCubeMembers(datasetId, d, measure, (dsId, m) => removeMeasure(dsId, user, m));
  // Forget the lifecycle flag (the registry side of the delete).
  lc().flags.delete(metricId);
  mirror.deleteThrough(metricId);
  return { recordDeleted: true, physical };
}

/**
 * RESTORE a metric that was deleted (or a prior definition): re-define the measure from a
 * version snapshot. Auditable + reversible — the CURRENT measure (if any) is snapshotted
 * first, THEN the chosen version's measure is re-defined on the dataset. Edit-scoped.
 */
export function restoreMetricVersion(metricId: string, user: Principal, version: number): { id: string } {
  const { measure } = splitId(metricId);
  const datasetId = requireDatasetEdit(metricId, user); // edit-scoped, measure may be gone
  const snap = versions.get(metricId, version);
  if (!snap) throw new MetricError(`version ${version} not found`, 404);
  const restored = (snap.state as { measure?: Measure }).measure;
  if (!restored) throw new MetricError(`version ${version} has no restorable measure`, 422);

  // Snapshot the live measure first (if it still exists) so the restore can be undone.
  const d = getDataset(datasetId, user);
  const live = d.measures.find((x) => x.name === measure);
  if (live) versions.record(metricId, user.id, { measure: live }, `restore of v${version}`);

  // Re-define is a no-op collision if the measure is already present with this name.
  if (!live) defineMeasure(datasetId, user, restored);
  // Restoring un-archives (it is back in the working lists).
  setFlag(metricId, false);
  return { id: metricId };
}

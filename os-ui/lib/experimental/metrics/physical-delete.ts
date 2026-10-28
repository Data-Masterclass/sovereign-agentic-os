/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../data/index.ts';
import { modelName, viewName } from '@/lib/experimental/data';
import { measureMember } from './model.ts';

/**
 * PHYSICAL cleanup for a metric DELETE (never for archive — archive is a reversible
 * registry-only soft-hide; restore must bring the measure back intact).
 *
 * A metric IS a measure bound to a Gold mart: every consumer (the explorer, dashboards,
 * the agent metrics tool) resolves its `<View>.<measure>` member from the dataset's
 * `measures`. A "deleted" metric that is still a measure on the dataset isn't deleted —
 * it stays queryable. So DELETE must DE-REGISTER the measure: remove it from the dataset's
 * `measures` (the one source), which drops the member everywhere — physical
 * de-registration. Archive keeps the measure (and thus the member) intact.
 *
 * Pure planning + injected executor, so the plan and the honest report fold are unit-
 * testable without a store; the lifecycle store injects the real `removeMeasure`.
 */

export type ModelTarget = {
  /** The metric member that stops resolving once de-registered (`Orders.revenue`). */
  member: string;
  /** The model the measure lives on (the dataset's frozen model identity). */
  cube: string;
  /** The view dashboards + the agent metrics tool resolve. */
  view: string;
  /** The measure's machine name (the leaf that is dropped from the model). */
  measure: string;
};

/**
 * The single member this metric occupies. A metric maps 1:1 to one measure on one
 * model, so the plan is exactly one target (kept as the same shape as the dataset
 * planner: a list, so the report fold is identical across the OS).
 */
export function deregisterPlan(d: Dataset, measure: Measure): ModelTarget[] {
  return [
    {
      member: measureMember(d, measure),
      cube: modelName(d),
      view: viewName(d),
      measure: measure.name,
    },
  ];
}

export type PhysicalTarget = { target: string; ok: boolean; reason: string };
export type PhysicalDeleteReport = { recordDeleted: boolean; physical: PhysicalTarget[] };

/** Removes the measure from its dataset. Injected for testability. Returns whether a
 *  measure was actually removed (false → already gone / not permitted upstream). */
export type DeregisterFn = (datasetId: string, measure: string) => { removed: boolean };

/**
 * De-register every planned member, best-effort per target: a failure (the dataset
 * gone, the caller not permitted to edit it, the measure already dropped) never blocks
 * the delete — the metric record delete stands, and every miss is reported honestly with
 * its real reason. Mirrors `lib/data/physical-delete.dropPhysicalTables`.
 */
export function deregisterViewMembers(
  datasetId: string,
  d: Dataset,
  measure: Measure,
  deregister: DeregisterFn,
): PhysicalTarget[] {
  const out: PhysicalTarget[] = [];
  for (const t of deregisterPlan(d, measure)) {
    try {
      const res = deregister(datasetId, t.measure);
      out.push({
        target: t.member,
        ok: res.removed,
        reason: res.removed
          ? `de-registered from model '${t.cube}' — the member no longer resolves`
          : 'measure was already absent from the model',
      });
    } catch (e) {
      out.push({ target: t.member, ok: false, reason: (e as Error).message || 'de-register failed' });
    }
  }
  return out;
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Physical de-registration of a deleted metric's measure
 * USER STORY: As a creator deleting a metric I want it to stop resolving everywhere, with a report of what
 *             was removed, so that a deleted metric cannot keep serving numbers.
 * ARCHITECTURE:
 *   - Pure plan (`deregisterPlan`, always one target: the measure's member on its model/view) plus an
 *     injected executor; `./lifecycle.ts` injects the Data store's `removeMeasure`.
 *   - Best-effort per target: a failure is reported with its reason and never blocks the delete.
 *   - Used for delete only; archive keeps the measure.
 */
import type { Dataset, Measure } from '@tabs/data/lib/index';
import { modelName, viewName } from '@tabs/data/lib/index';
import { measureMember } from '@tabs/metrics/lib/model';

export type ModelTarget = {
  /** The metric member that stops resolving once de-registered (`Orders.revenue`). */
  member: string;
  /** The model the measure lives on (the dataset's frozen model identity). */
  model: string;
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
      model: modelName(d),
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
          ? `de-registered from model '${t.model}' — the member no longer resolves`
          : 'measure was already absent from the model',
      });
    } catch (e) {
      out.push({ target: t.member, ok: false, reason: (e as Error).message || 'de-register failed' });
    }
  }
  return out;
}

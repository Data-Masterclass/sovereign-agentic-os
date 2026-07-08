/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../data/dataset-schema.ts';
import { cubeName, cubeViewName } from '../data/metrics.ts';
import { measureMember } from './model.ts';

/**
 * PHYSICAL cleanup for a metric DELETE (never for archive — archive is a reversible
 * registry-only soft-hide; restore must bring the measure back intact).
 *
 * A metric IS a Cube measure bound to a Gold mart: `lib/data/metrics.ts` +
 * `lib/data/cube-models.ts` emit the dataset's measures into the `/api/cube/models`
 * payload the Cube model-sync sidecar loads. A "deleted" metric that is still a member
 * on the delivered Cube model isn't deleted — it stays queryable by the explorer, the
 * agent metrics tool and Superset. So DELETE must DE-REGISTER the measure from its cube:
 * the executor drops the measure from the dataset (`removeMeasure`), which removes it
 * from `buildCubeModels(datasets).models[].measures` — physical de-registration. Archive
 * keeps the measure (and thus the Cube model) intact.
 *
 * Pure planning + injected executor, so the plan and the honest report fold are unit-
 * testable without a store; the lifecycle store injects the real `removeMeasure`.
 */

export type CubeTarget = {
  /** The metric member that stops resolving once de-registered (`Orders.revenue`). */
  member: string;
  /** The cube the measure lives on (matches the OPA/compiler key + the model name). */
  cube: string;
  /** The Cube view dashboards + the agent metrics tool resolve. */
  view: string;
  /** The measure's machine name (the leaf that is dropped from the model). */
  measure: string;
};

/**
 * The single Cube member this metric occupies. A metric maps 1:1 to one measure on one
 * cube, so the plan is exactly one target (kept as the same shape as the dataset
 * planner: a list, so the report fold is identical across the OS).
 */
export function deregisterPlan(d: Dataset, measure: Measure): CubeTarget[] {
  return [
    {
      member: measureMember(d, measure),
      cube: cubeName(d),
      view: cubeViewName(d),
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
 * De-register every planned Cube member, best-effort per target: a failure (the dataset
 * gone, the caller not permitted to edit it, the measure already dropped) never blocks
 * the delete — the metric record delete stands, and every miss is reported honestly with
 * its real reason. Mirrors `lib/data/physical-delete.dropPhysicalTables`.
 */
export function deregisterCubeMembers(
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
          ? `de-registered from Cube model '${t.cube}' — no longer in /api/cube/models`
          : 'measure was already absent from the Cube model',
      });
    } catch (e) {
      out.push({ target: t.member, ok: false, reason: (e as Error).message || 'de-register failed' });
    }
  }
  return out;
}

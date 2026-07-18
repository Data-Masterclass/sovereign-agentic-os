/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ExecuteIdentity } from '@/lib/infra/governed';
import { visibilityFor, type Dataset } from './dataset-schema.ts';
import {
  applyApprovedPromotion,
  listGovernedDatasets,
  requireDomainTableMaterialized,
  validatePromotion,
  type MaterializationVerifier,
  type Principal,
  type PromotionRequest,
} from './store.ts';
import { publishPlan } from './transform.ts';
import { buildCubeModels } from './cube-models.ts';
import { cubeName } from './metrics.ts';
import type { DataBuildReport } from './build/orchestrate.ts';

/**
 * The PHYSICAL PUBLISH behind a `dataset_promote` approval (T8). Approval IS the
 * action — and the action is now real: the promote adapter-set materializes
 * `assetTarget(d)` (`iceberg.<domain>.<layer>_<slug>`) with a governed CTAS from the
 * requester's built personal-lane table, pushes the compiled OPA bundle, and runs
 * the conformance gate. Two contracts are enforced HERE, not in the routes:
 *
 *   1. SEPARATION OF DUTIES — the CTAS runs as the APPROVING Builder's identity
 *      (never the requester's). The requester cannot self-materialize into the
 *      domain schema: a creator can't approve (role gate in `validatePromotion`),
 *      and the write floor in the query-tool guard requires builder+ anyway.
 *   2. HONESTY — the registry tier flips ONLY when the build report is ✓. A failed
 *      materialization returns the real Trino error and leaves the tier unchanged.
 *
 * Pure module: the server-only build runner is INJECTED (`deps.buildPromote`), so
 * the whole approval→publish→flip chain is unit-testable against fakes.
 */

/** The write bundle the promote build threads to the dbt-trino adapter. */
export type PublishWrite = {
  transformSql: string;
  schemaSql: string;
  identity: ExecuteIdentity;
  releaseSchema: string;
};

export type PublishDeps = {
  /** Run the `promote` adapter-set for the dataset (server-side: `buildStage`). */
  buildPromote(
    dataset: Dataset,
    principal: string,
    write: PublishWrite,
  ): Promise<DataBuildReport & { mode: string }>;
  /** FAIL-CLOSED (#96): an INDEPENDENT probe that the promoted DOMAIN table is
   *  queryable via the governed query path — run right before the tier flip, so a
   *  vacuous/mismatched build ✓ can't leak an un-materialized asset. Wired to the real
   *  Trino `tableQueryable` server-side; a test may inject a fake to prove the gate. */
  verifyDomainTable: MaterializationVerifier;
};

export type PublishOutcome =
  | {
      ok: true;
      fqn: string;
      mode: string;
      report: DataBuildReport;
      /** The Cube view now in the `/api/cube/models` payload (null when no Gold). */
      cubeView: string | null;
      dataset: Dataset;
    }
  | { ok: false; fqn: string; mode?: string; report?: DataBuildReport; error: string };

/**
 * Validate → physically materialize → flip. Throws a DatasetError (with HTTP
 * status) for authorization/state failures — the same gates `applyApprovedPromotion`
 * enforces — and returns `{ ok: false }` with the real error when the PHYSICAL
 * build fails (tier untouched).
 */
export async function publishApprovedPromotion(
  req: PromotionRequest,
  approver: Principal,
  deps: PublishDeps,
): Promise<PublishOutcome> {
  // 1. Every promotion gate, WITHOUT flipping (tier/role/domain/transparency).
  const d = validatePromotion(req, approver);

  // 2. Compile the publish plan (source = the requester's personal-lane table).
  const plan = publishPlan(d);

  // 3. The approver's identity — uid AND Trino session principal are the APPROVING
  //    Builder, so the write floor, the OPA read governance inside the CTAS and the
  //    Trino audit trail all name the approver (separation of duties).
  const identity: ExecuteIdentity = {
    principal: approver.id,
    uid: approver.id,
    domains: approver.domains,
    role: approver.role,
  };

  // 4. Build against the POST-promotion view of the dataset (tier/visibility/grants
  //    as the request defines them) so the policy adapter compiles + pushes the
  //    PROMOTED FQN's governance — the registry itself is not touched yet.
  const preview: Dataset = {
    ...d,
    tier: 'asset',
    visibility: visibilityFor('asset', req.visibility),
    grants: req.grants,
  };
  const report = await deps.buildPromote(preview, approver.id, {
    transformSql: plan.sql,
    schemaSql: plan.schemaSql,
    identity,
    releaseSchema: plan.sourceSchema,
  });

  // 5. HONESTY: a failed materialization/probe/policy row leaves the tier unchanged.
  if (!report.ok) {
    const failed = report.rows.find((r) => r.status === 'fail');
    return {
      ok: false,
      fqn: plan.target,
      mode: report.mode,
      report,
      error: failed?.error ?? 'the physical publish did not pass',
    };
  }

  // 6. FAIL-CLOSED (#96): re-probe the EXACT domain target independently of the build
  //    report — a promotion never flips while the gold lives only in `personal_<owner>`
  //    (the Northpeak gap). Throws 502 (tier untouched) if the domain table is absent.
  await requireDomainTableMaterialized(plan.target, approver, deps.verifyDomainTable);

  // 7. ✓ only: flip the registry tier (re-validates; 409 on a concurrent flip).
  const dataset = applyApprovedPromotion(req, approver);

  // 8. The Cube leg (T7): governed datasets with a built Gold now appear in the
  //    `/api/cube/models` payload the sync sidecar delivers (≤60s on the cluster).
  const view = buildCubeModels(listGovernedDatasets()).models.find(
    (m) => m.name === cubeName(dataset), // #155: the dataset's (possibly namespaced) cube name
  );

  return { ok: true, fqn: plan.target, mode: report.mode, report, cubeView: view?.view ?? null, dataset };
}

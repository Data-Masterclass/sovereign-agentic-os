/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '../dataset-schema.ts';
import type { ExecuteIdentity } from '@/lib/infra/governed';

/**
 * The ONE Data Build adapter interface (clone of lib/agents/build/adapter.ts). Each
 * lifecycle STAGE runs an ADAPTER-SET: every adapter does the real `apply` against
 * its tool then a `verify` probe that it actually worked. Per-tool best-path; LIVE
 * when the service is reachable, an honest offline-MOCK otherwise.
 *
 * The cardinal rule (tested): a row is ✓ ONLY when BOTH apply AND verify pass — Build
 * can never report success without a passing verification (data-ui-ux.md §"Build =
 * execute + verify"). Mirrors the agent-runtime so both tabs share one discipline.
 */

export type StepResult = { ok: boolean; detail: string; error?: string };

/** The lifecycle stages a Build runs (brief §"stage→adapter-set"). */
export type DataStage = 'bronze' | 'silver' | 'gold' | 'metric' | 'dashboard' | 'promote' | 'certify';

export type DataBuildContext = {
  dataset: Dataset;
  /** Generated tool-native files for this build (cube yaml, exposure, bundle…). */
  artifacts: Record<string, string>;
  /** The acting principal (delegated identity) — forwarded to governed probes. */
  principal?: string;
  /** The stage being built (so an adapter shared across stages picks the right model). */
  stage?: DataStage;
  /** Compiled, allowlisted transform SQL (guided Silver/Gold builder) to EXECUTE via
   *  the governed write path. When present with {@link identity}, the dbt adapter runs
   *  a REAL CTAS instead of a verify-only probe. Absent ⇒ verify-only (pass-through). */
  transformSql?: string;
  /** The PHYSICAL table this build targets (`iceberg.<schema>.<layer>_<slug>`),
   *  resolved by the route from the dataset tier + caller identity (personal vs
   *  domain schema). The dbt adapter probes THIS name — the same table the CTAS
   *  wrote — so verify can never pass against a table the build didn't touch. */
  targetFqn?: string;
  /** The caller identity for the governed WRITE — derived server-side from the signed
   *  session (never the request body). Threaded to {@link ExecuteIdentity}-based writes.
   *  For the `promote` stage this is the APPROVING Builder (separation of duties). */
  identity?: ExecuteIdentity;
  /** Publish (promote) only: `CREATE SCHEMA IF NOT EXISTS iceberg.<domain>` run
   *  before the CTAS so a first-ever domain publish doesn't fail on the namespace. */
  schemaSql?: string;
  /** Publish (promote) only: the requester's `personal_<uid>` schema the CTAS reads —
   *  released read-only to the approver for the duration of the publish (trino.rego
   *  `data.governance.releases`), withdrawn immediately after. */
  releaseSchema?: string;
};

export interface DataAdapter {
  /** Tool key shown in the Build table: dlt | dbt | dbt-trino | trino | cube | superset | om | policy. */
  tool: string;
  apply(ctx: DataBuildContext): Promise<StepResult>;
  verify(ctx: DataBuildContext): Promise<StepResult>;
}

export type BuildStatus = 'ok' | 'fail';

export type BuildRow = {
  tool: string;
  applied: boolean;
  verified: boolean;
  status: BuildStatus;
  detail: string;
  error?: string;
};

/**
 * Run one adapter apply→verify and fold it into a single ✓/✗ row. Verify is
 * short-circuited if apply fails; any throw is caught and reported as ✗ (so a live
 * client network error surfaces honestly, never a false ✓).
 */
export async function runAdapter(adapter: DataAdapter, ctx: DataBuildContext): Promise<BuildRow> {
  let applied = false;
  let verified = false;
  let detail = '';
  try {
    const ap = await adapter.apply(ctx);
    applied = ap.ok;
    detail = ap.detail;
    if (!ap.ok) return { tool: adapter.tool, applied, verified, status: 'fail', detail, error: ap.error ?? 'apply failed' };
    const vr = await adapter.verify(ctx);
    verified = vr.ok;
    detail = vr.detail || detail;
    if (!vr.ok) return { tool: adapter.tool, applied, verified, status: 'fail', detail, error: vr.error ?? 'verify failed' };
    return { tool: adapter.tool, applied, verified, status: 'ok', detail };
  } catch (e) {
    return { tool: adapter.tool, applied, verified, status: 'fail', detail, error: (e as Error).message };
  }
}

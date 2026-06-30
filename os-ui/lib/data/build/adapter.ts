/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '../dataset-schema.ts';

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

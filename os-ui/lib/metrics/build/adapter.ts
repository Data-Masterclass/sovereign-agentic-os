/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../../data/dataset-schema.ts';

/**
 * The ONE adapter interface for the Metrics + Dashboards builds (the Opus deliverable),
 * the same discipline as lib/agents/build + lib/data/build: every adapter does the real
 * `apply` against its tool then a `verify` probe that it actually worked, and a row is ✓
 * ONLY when BOTH pass. LIVE when the service is reachable, an honest offline-MOCK
 * otherwise — same adapter logic both paths, so a ✓ always means a real apply+verify.
 *
 * Generic over the build context so Dashboards reuses it (build/dashboards imports
 * {@link BuildAdapter} + {@link runAdapter}) — one interface, no drift.
 */

export type StepResult = { ok: boolean; detail: string; error?: string };

export function ok(detail: string): StepResult {
  return { ok: true, detail };
}
export function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}

export interface BuildAdapter<Ctx> {
  /** Tool key shown in the Build table (cube | metric-explorer | superset | embed …). */
  tool: string;
  apply(ctx: Ctx): Promise<StepResult>;
  verify(ctx: Ctx): Promise<StepResult>;
}

export type BuildStatus = 'ok' | 'fail';
export type BuildRow = { tool: string; applied: boolean; verified: boolean; status: BuildStatus; detail: string; error?: string };

/**
 * Run one adapter apply→verify into a single ✓/✗ row. Verify is short-circuited if
 * apply fails; any throw is caught and reported ✗ (a live network error surfaces
 * honestly, never a false ✓).
 */
export async function runAdapter<Ctx>(adapter: BuildAdapter<Ctx>, ctx: Ctx): Promise<BuildRow> {
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

/** The context a Metric build runs against (define a measure → cube → explore). */
export type MetricBuildContext = {
  dataset: Dataset;
  measure: Measure;
  /** The generated Cube measures/views YAML (the cube_dbt artifact). */
  schema: string;
  /** The canonical member every consumer resolves. */
  member: string;
  /** The viewer's Cube security context (R3) for the explorer probe. */
  securityContext: Record<string, unknown>;
};

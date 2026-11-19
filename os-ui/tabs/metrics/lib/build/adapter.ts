/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Build adapter contract for the metric build — apply, then verify, into one row
 * USER STORY: As a creator I want a metric build to show a tick only when the step both ran and was
 *             checked to have worked, so that a tick always means a real result.
 * ARCHITECTURE:
 *   - `BuildAdapter<Ctx>` (apply + verify) and `runAdapter`, which turns one adapter into a ✓/✗
 *     `BuildRow`; verify is skipped if apply fails and any throw becomes ✗.
 *   - Generic over the context, but today only the metric build uses it (`./live.ts`, `./server.ts`).
 *   - `MetricBuildContext` carries the viewer's delegated token so the SQL runs as the viewer.
 */
import type { Dataset, Measure, DelegatedToken } from '@tabs/data/lib/index';
import type { MetricExploreResult } from '@tabs/metrics/lib/build/live';

export type StepResult = { ok: boolean; detail: string; error?: string };

export function ok(detail: string): StepResult {
  return { ok: true, detail };
}
export function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}

export interface BuildAdapter<Ctx> {
  /** Tool key shown in the Build table (trino | embed …). */
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

/** The context a Metric build runs against (define a measure → run its governed SQL). */
export type MetricBuildContext = {
  dataset: Dataset;
  measure: Measure;
  /** The canonical member every consumer resolves. */
  member: string;
  /** The viewer's delegated token (R3) — the governed SQL runs AS this identity. */
  token: DelegatedToken;
  /** Set by the adapter's apply: the explore result verify checks (never pre-filled). */
  outcome?: MetricExploreResult;
};

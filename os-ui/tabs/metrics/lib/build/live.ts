/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric build adapter — the single `trino` apply/verify step
 * USER STORY: As a creator I want building a metric to run its governed SQL as me and check that it
 *             resolves to a number, so that a built metric is known to compute.
 * ARCHITECTURE:
 *   - Apply runs the injected `explore` (in production `exploreMetric`); verify sums the member over
 *     the rows and fails when there is no number or the result is pending.
 *   - Pure: the explore function is injected so it is unit-tested with a fake. Used by `./server.ts`.
 */
import type { Dataset, Measure } from '@tabs/data/lib/index';
import type { DelegatedToken } from '@tabs/data/lib/index';
import { type BuildAdapter, type MetricBuildContext, ok, fail } from '@tabs/metrics/lib/build/adapter';

/** The slice of an explore result the build needs (structurally `ExploreServerResult`). */
export type MetricExploreResult = {
  rows: Record<string, unknown>[];
  mode: 'live' | 'live (sql)' | 'offline-mock' | 'unavailable';
  pending?: boolean;
  unavailable?: boolean;
  warning?: string;
};

export type MetricExplore = (dataset: Dataset, measure: Measure, token: DelegatedToken) => Promise<MetricExploreResult>;

export type MetricLiveDeps = { explore: MetricExplore };

/** Sum the member's value across the rows (the number for the KPI); null if any row
 *  carries a non-numeric value or there are no rows. */
export function memberValue(rows: Record<string, unknown>[], member: string): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const r of rows) {
    const v = Number(r[member] ?? r[member.split('.')[1]]);
    if (Number.isNaN(v)) return null;
    total += v;
  }
  return total;
}

export function makeMetricAdapters(deps: MetricLiveDeps): Record<string, BuildAdapter<MetricBuildContext>> {
  const trino: BuildAdapter<MetricBuildContext> = {
    tool: 'trino',
    async apply(ctx) {
      const r = await deps.explore(ctx.dataset, ctx.measure, ctx.token);
      if (r.unavailable) return fail(r.warning ?? 'the governed lakehouse (Trino) is unreachable — no number computed');
      ctx.outcome = r;
      if (r.pending) return ok(`compiled '${ctx.member}' as governed SQL — value pending`);
      return ok(`ran governed SQL for '${ctx.member}' as the viewer (${r.rows.length} row(s), ${r.mode})`);
    },
    async verify(ctx) {
      const r = ctx.outcome;
      if (!r) return fail(`'${ctx.member}' was not computed`);
      if (r.pending) return fail(`metric '${ctx.member}' did not resolve yet — ${r.warning ?? 'it needs a time slice to compute'}`);
      const v = memberValue(r.rows, ctx.member);
      if (v === null) return fail(`metric '${ctx.member}' did not resolve to a number`);
      return ok(`'${ctx.member}' = ${v} via governed Trino SQL (${r.mode})`);
    },
  };
  return { trino };
}

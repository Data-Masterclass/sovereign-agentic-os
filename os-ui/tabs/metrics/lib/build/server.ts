/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric build server boundary — `buildMetric`
 * USER STORY: As a creator I want a build report for my metric that says whether it ran live, on the
 *             offline mock or not at all, so that I know how far to trust it.
 * ARCHITECTURE:
 *   - Server-only. Derives the canonical member, runs the `trino` adapter from `./live.ts` through
 *     `runAdapter`, and maps the explore mode into `BuildMode`.
 *   - Called by `app/api/metrics/define/route.ts` and the metric (and other) MCP write tools.
 */
import 'server-only';
import type { Dataset, Measure } from '@tabs/data/lib/index';
import type { DelegatedToken } from '@tabs/data/lib/index';
import { measureMember } from '@tabs/metrics/lib/model';
import { type BuildRow, type MetricBuildContext, runAdapter } from '@tabs/metrics/lib/build/adapter';
import { type MetricLiveDeps, makeMetricAdapters } from '@tabs/metrics/lib/build/live';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';

/** 'unavailable' is its OWN state (2026-11-18, review M3): a metric Build over an unreachable
 *  Trino used to be reported as `live`, because the mapping below folded everything that was not
 *  `offline-mock` into it — so the one outcome that means "nothing ran" read as the one that means
 *  "it really ran". */
export type BuildMode = 'live' | 'offline-mock' | 'unavailable';
export type MetricBuildReport = {
  rows: BuildRow[];
  ok: boolean;
  member: string;
  mode: BuildMode;
  /**
   * The measure didn't resolve yet because its number needs a slice the build doesn't
   * supply (a rolling-window / running-total metric needs a time dimension), NOT a
   * genuine failure. The metric is persisted; the explorer computes it with a time slice.
   */
  pending?: boolean;
};

export async function buildMetric(
  dataset: Dataset,
  measure: Measure,
  token: DelegatedToken,
  deps: MetricLiveDeps = { explore: exploreMetric },
): Promise<MetricBuildReport> {
  const ctx: MetricBuildContext = { dataset, measure, member: measureMember(dataset, measure), token };
  const adapters = makeMetricAdapters(deps);
  const rows = [await runAdapter(adapters.trino, ctx)];
  const ok = rows.every((r) => r.status === 'ok');
  const outcome = ctx.outcome?.mode;
  const mode: BuildMode =
    outcome === 'offline-mock' ? 'offline-mock' : outcome === 'unavailable' ? 'unavailable' : 'live';
  const pending = !ok && ctx.outcome?.pending === true;
  return { rows, ok, member: ctx.member, mode, ...(pending ? { pending: true } : {}) };
}

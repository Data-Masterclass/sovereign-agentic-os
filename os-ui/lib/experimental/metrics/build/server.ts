/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset, Measure } from '../../data/index.ts';
import type { DelegatedToken } from '@/lib/experimental/data';
import { measureMember } from '../model.ts';
import { type BuildRow, type MetricBuildContext, runAdapter } from './adapter.ts';
import { type MetricLiveDeps, makeMetricAdapters } from './live.ts';
import { exploreMetric } from './explore-server.ts';

/**
 * Server boundary for a Metric build (mirrors lib/data/build/server.ts). It derives the
 * canonical member, then runs the `trino` adapter: the metric's compiled governed SQL over
 * the gold mart AS the viewer (R3), verified to resolve to a number. `exploreMetric`
 * decides live vs the honest offline-mock (and the loud outage gate), so the report's
 * mode is whatever the read path honestly ran as.
 */

export type BuildMode = 'live' | 'offline-mock';
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
  const mode: BuildMode = ctx.outcome?.mode === 'offline-mock' ? 'offline-mock' : 'live';
  const pending = !ok && ctx.outcome?.pending === true;
  return { rows, ok, member: ctx.member, mode, ...(pending ? { pending: true } : {}) };
}

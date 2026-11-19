/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset, Measure } from '@tabs/data/lib/index';
import type { DelegatedToken } from '@tabs/data/lib/index';
import { measureMember } from '@tabs/metrics/lib/model';
import { type BuildRow, type MetricBuildContext, runAdapter } from '@tabs/metrics/lib/build/adapter';
import { type MetricLiveDeps, makeMetricAdapters } from '@tabs/metrics/lib/build/live';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';

/**
 * Server boundary for a Metric build (mirrors lib/data/build/server.ts). It derives the
 * canonical member, then runs the `trino` adapter: the metric's compiled governed SQL over
 * the gold mart AS the viewer (R3), verified to resolve to a number. `exploreMetric`
 * decides live vs the honest offline-mock (and the loud outage gate), so the report's
 * mode is whatever the read path honestly ran as.
 */

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
  /** Why the build is not `live` (the failing step's reason), so the state is never unexplained. */
  reason?: string;
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
  const mode = buildModeOf(ctx.outcome);
  const pending = !ok && ctx.outcome?.pending === true;
  const reason = mode === 'live' ? undefined : (rows.find((r) => r.error)?.error ?? ctx.outcome?.warning);
  return { rows, ok, member: ctx.member, mode, ...(pending ? { pending: true } : {}), ...(reason ? { reason } : {}) };
}

/**
 * The mode a build honestly ran as. `live` ONLY when the governed read path really answered
 * (an explore result came back in a live mode). No result at all — the explore step said it was
 * unavailable, or it threw — means nothing ran, so the build is `unavailable`, never `live`.
 */
export function buildModeOf(outcome: MetricBuildContext['outcome']): BuildMode {
  if (!outcome) return 'unavailable';
  if (outcome.mode === 'offline-mock') return 'offline-mock';
  if (outcome.unavailable || outcome.mode === 'unavailable') return 'unavailable';
  return 'live';
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset, Measure } from '../../data/dataset-schema.ts';
import { type DelegatedToken, propagate } from '../../data/identity.ts';
import { scaffoldCubeYaml } from '../../data/metrics.ts';
import { measureMember } from '../model.ts';
import { type BuildRow, type MetricBuildContext, runAdapter } from './adapter.ts';
import { makeMetricAdapters } from './live.ts';
import { makeMockMetricAdapters, newMetricMock } from './mocks.ts';
import { makeRealMetricClients, liveMetricsReachable } from './live-clients.ts';

/**
 * Server boundary for a Metric build (mirrors lib/data/build/server.ts). It scaffolds
 * the Cube measures/views YAML, derives the canonical member + the viewer's R3 security
 * context from the delegated token, then runs the `cube` + `metric-explorer` adapters
 * against LIVE Cube when reachable, or the honest offline-MOCK otherwise — labelled
 * either way. Same adapter logic both paths, so a ✓ is a real apply+verify (the measure
 * resolves AND the explorer's number matches the agent's).
 */

export type BuildMode = 'live' | 'offline-mock';
export type MetricBuildReport = {
  rows: BuildRow[];
  ok: boolean;
  member: string;
  mode: BuildMode;
  /**
   * Live only: the measure didn't resolve yet because the model-sync sidecar hasn't
   * pushed it to Cube (sync lag), NOT a genuine failure. The metric is persisted; its
   * live value appears within a few seconds. Distinguishes "syncing" from "broken".
   */
  pending?: boolean;
};

function contextFor(dataset: Dataset, measure: Measure, token: DelegatedToken): MetricBuildContext {
  return {
    dataset,
    measure,
    schema: scaffoldCubeYaml(dataset),
    member: measureMember(dataset, measure),
    securityContext: propagate(token).cube.securityContext, // R3 — the viewer's identity
  };
}

export async function buildMetric(dataset: Dataset, measure: Measure, token: DelegatedToken): Promise<MetricBuildReport> {
  const ctx = contextFor(dataset, measure, token);
  const adapters = (await liveMetricsReachable())
    ? { set: makeMetricAdapters(makeRealMetricClients()), mode: 'live' as const }
    : { set: makeMockMetricAdapters(newMetricMock()), mode: 'offline-mock' as const };
  const rows: BuildRow[] = [];
  for (const tool of ['cube', 'metric-explorer']) {
    rows.push(await runAdapter(adapters.set[tool], ctx));
  }
  const ok = rows.every((r) => r.status === 'ok');
  // PENDING (live only): the sole reason the build isn't green is that the measure hasn't
  // resolved yet — the sidecar hasn't pushed it to Cube. resolveMeasure returned null (we
  // fail-soft the "not found for path" 400), so every failing row is a non-resolution, not
  // a genuine error. The metric IS persisted; the value converges within a few seconds.
  const pending =
    !ok &&
    adapters.mode === 'live' &&
    rows.every((r) => r.status === 'ok' || /did not resolve|no usable rows|did not resolve on both/i.test(r.detail));
  return { rows, ok, member: ctx.member, mode: adapters.mode, ...(pending ? { pending: true } : {}) };
}

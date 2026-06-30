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
export type MetricBuildReport = { rows: BuildRow[]; ok: boolean; member: string; mode: BuildMode };

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
  return { rows, ok: rows.every((r) => r.status === 'ok'), member: ctx.member, mode: adapters.mode };
}

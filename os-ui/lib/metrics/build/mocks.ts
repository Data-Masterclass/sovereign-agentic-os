/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type BuildAdapter, type MetricBuildContext } from './adapter.ts';
import { type MetricCubeClient, type MetricLiveDeps, makeMetricAdapters } from './live.ts';

/**
 * The honest OFFLINE-MOCK Cube backend (kind/laptop, no services). A real in-process
 * client: `reload` records the schema, `resolveMeasure`/`explore` read it back — so the
 * SAME adapter logic ({@link makeMetricAdapters}) runs against it and the mock can't
 * drift from live. A measure resolves ONLY after its schema was actually reloaded, and
 * the explorer's number is computed from the same loaded value the agent path returns,
 * so the consistency verify is a real check, not a rubber stamp.
 */

export type MetricMockBackend = { schemas: Map<string, string> };

export function newMetricMock(): MetricMockBackend {
  return { schemas: new Map() };
}

/** Deterministic value for a member once it has been loaded (stable across both paths). */
function valueOf(member: string): number {
  let h = 0;
  for (let i = 0; i < member.length; i++) h = (h * 31 + member.charCodeAt(i)) | 0;
  return Math.abs(h % 100000);
}

function mockCube(b: MetricMockBackend): MetricCubeClient {
  const loaded = (member: string) => b.schemas.has(member.split('.')[0]);
  return {
    async reload(view, schema) { b.schemas.set(view, schema); },
    async resolveMeasure(member) { return loaded(member) ? valueOf(member) : null; },
    async explore(query, _ctx) {
      const member = query.measures[0];
      if (!loaded(member)) return { rows: [] };
      // One total row carrying the same value the agent path resolves (consistency).
      return { rows: [{ [member]: valueOf(member) }] };
    },
  };
}

export function mockMetricDeps(b: MetricMockBackend): MetricLiveDeps {
  return { cube: mockCube(b) };
}

export function makeMockMetricAdapters(b: MetricMockBackend): Record<string, BuildAdapter<MetricBuildContext>> {
  return makeMetricAdapters(mockMetricDeps(b));
}

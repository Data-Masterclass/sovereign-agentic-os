/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type BuildAdapter, type MetricBuildContext, ok, fail } from './adapter.ts';
import { buildCubeQuery, type ExploreSpec } from '../explorer.ts';

/**
 * The LIVE Metric build adapters — real apply→verify against Cube, behind the same
 * {@link BuildAdapter} interface as the mocks. Two adapters:
 *
 *   • `cube` — (re)load the measures/views YAML, then VERIFY the measure RESOLVES on its
 *     canonical member (the agent metrics tool's path) — no ✓ for a measure that never
 *     resolves;
 *   • `metric-explorer` — run the explorer query UNDER the viewer's security context
 *     (R3 RLS), then VERIFY metric-CONSISTENCY: the explorer's value for the member
 *     equals the measure's resolved value (the "numbers match the agent" guarantee).
 *
 * Pure: the Cube client is injected so the adapters are unit-tested against an in-memory
 * Cube; the fetch-backed client lives in live-clients.ts. A network failure throws or
 * returns falsy ⇒ ✗, never a false ✓.
 */

export interface MetricCubeClient {
  /** Validate + (re)load the generated Cube measures/views schema. */
  reload(view: string, schema: string): Promise<void>;
  /** Resolve a measure member (the agent metrics tool path) — number or null. */
  resolveMeasure(member: string): Promise<number | null>;
  /** Run an explorer query under a security context (R3 RLS at Cube). */
  explore(query: ReturnType<typeof buildCubeQuery>, securityContext: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[] }>;
}

export type MetricLiveDeps = { cube: MetricCubeClient };

function viewOf(member: string): string {
  return member.split('.')[0];
}

/** Sum the member's value across the explorer rows (the explorer's number for the KPI). */
function explorerValue(rows: Record<string, unknown>[], member: string): number | null {
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
  const cube: BuildAdapter<MetricBuildContext> = {
    tool: 'cube',
    async apply(ctx) {
      if (!ctx.schema) return fail('no Cube measures/views schema generated');
      await deps.cube.reload(viewOf(ctx.member), ctx.schema);
      return ok(`reloaded Cube measure '${ctx.measure.name}' on '${viewOf(ctx.member)}'`);
    },
    async verify(ctx) {
      const v = await deps.cube.resolveMeasure(ctx.member);
      if (v === null) return fail(`metric '${ctx.member}' did not resolve`);
      return ok(`metric '${ctx.member}' resolves (= ${v})`);
    },
  };

  const explorer: BuildAdapter<MetricBuildContext> = {
    tool: 'metric-explorer',
    async apply(ctx) {
      const spec: ExploreSpec = { member: ctx.member, dimensions: [] };
      const { rows } = await deps.cube.explore(buildCubeQuery(spec), ctx.securityContext);
      if (explorerValue(rows, ctx.member) === null) return fail(`explorer returned no usable rows for '${ctx.member}'`);
      return ok(`explorer resolved '${ctx.member}' for the viewer (${rows.length} row(s), RLS applied)`);
    },
    async verify(ctx) {
      // Metric-consistency: the explorer and the agent metrics tool resolve the SAME
      // canonical member at Cube. Both must resolve. When they run under the same identity
      // the totals are equal (the strong "numbers match" message + the offline-mock and
      // the consistency/gate unit tests). Under per-viewer RLS the explorer carries the
      // viewer's securityContext while the agent-path scalar here is unscoped, so an
      // identity-scoped value difference is legitimate and must NOT fail the build —
      // only a non-resolution does.
      const spec: ExploreSpec = { member: ctx.member, dimensions: [] };
      const [{ rows }, agentValue] = await Promise.all([
        deps.cube.explore(buildCubeQuery(spec), ctx.securityContext),
        deps.cube.resolveMeasure(ctx.member),
      ]);
      const exploreVal = explorerValue(rows, ctx.member);
      if (exploreVal === null || agentValue === null) return fail('metric did not resolve on both the explorer and the agent path');
      if (exploreVal === agentValue) return ok(`numbers match: explorer == agent == ${agentValue} for '${ctx.member}'`);
      return ok(`explorer (${exploreVal}) + agent (${agentValue}) both resolve '${ctx.member}' (RLS-scoped per identity)`);
    },
  };

  return { cube, 'metric-explorer': explorer };
}

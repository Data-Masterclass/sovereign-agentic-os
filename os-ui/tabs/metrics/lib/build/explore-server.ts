/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric explorer server boundary — run a metric as one governed Trino query
 * USER STORY: As a viewer I want a metric's number computed over the gold mart under my own identity,
 *             with the SQL shown, and no number at all during an outage, so that every value is real.
 * ARCHITECTURE:
 *   - Server-only. `exploreMetric` compiles the slice (`../explorer`), resolves the physical table
 *     through `builtLayerFqn` — the SAME resolver behind `get_dataset.queryable` — and runs it via
 *     `queryRun` as the delegated token's subject.
 *   - Labels each result `live (sql)`, `offline-mock` or `unavailable`. The hash-seeded mock is used
 *     only where `offlineMockAllowed()`; elsewhere an unreachable Trino returns no rows.
 *   - Adds loud warnings for dropped slice members, query-tool truncation and bucket-based windows.
 *   - Called by the metric routes, metric and other MCP tools, `./alert-eval.ts`, `./server.ts` and
 *     `tabs/dashboards/lib/build/panel-query.ts`.
 */
import 'server-only';
import { offlineMockAllowed } from '@core/kernel/offline-mock';
import { queryRun } from '@core/infra/governed';
import { routeForTable } from '@core/infra/trino-source';
import { propagate, type DelegatedToken } from '@core/kernel/identity';
import type { Dataset, Measure } from '@tabs/data/lib/index';
import { builtLayerFqn, isGoverned, isMissingTableError, NotBuiltError } from '@tabs/data/lib/store-fqn';
import {
  type ExploreSpec,
  type Granularity,
  dropToSql,
  exploreSpec,
  previewTrinoSql,
  serveRefusal,
  type ServeRefusal,
  sqlRowsToExploreRows,
} from '@tabs/metrics/lib/explorer';
import { liveMetricsReachable } from '@tabs/metrics/lib/build/live-clients';

/** 'live (sql)' = the number came from a governed Trino query over the gold mart (the
 *  metric read path since Phase 1), honestly labelled. 'unavailable' = a REAL deployment
 *  whose query backend is unreachable: we return NO number rather than a fabricated
 *  offline-mock one (see metricsMustBeLive). */
export type ExploreMode = 'live' | 'live (sql)' | 'offline-mock' | 'unavailable';

/**
 * Must this metric be computed for real? The governed query backend is required on any
 * deployment that has not EXPLICITLY asked for the teaching flow — if it's unreachable that's an
 * OUTAGE, and a metric must say so, never fabricate a plausible number. The offline-mock
 * resolver (a hash-seeded demo value) is legitimate only where no cluster exists and the mock is
 * clearly a worked example. This gate is what stops a made-up 286,936 from being shown as a KPI.
 *
 * IT USED TO READ `config.deploymentProfile !== 'local'`, AND THAT IS WHY IT FAILED. `OS_PROFILE`
 * is set nowhere in `charts/`, `values*.yaml`, `deploy/` or `scripts/` — `config.ts` says so
 * itself, twice — so on the live cluster this returned FALSE and the fabricated row was served.
 * The decision now belongs to the ONE kernel predicate, which keys on `NODE_ENV` like the other
 * two fail-closed guards in `config.ts`. See `core/kernel/offline-mock.ts`.
 */
function metricsMustBeLive(): boolean {
  return !offlineMockAllowed();
}

/**
 * The physical table a metric read targets, for THIS viewer. It is resolved by `builtLayerFqn`,
 * the one resolver that also produces `get_dataset.queryable` (and preview, profile and Talk), so
 * a metric, a dashboard panel and `query_data` on `queryable.fqn` always name the same table.
 *
 * There used to be a second derivation here (tier → `personal_<owner>` or `<domain>` schema). It
 * disagreed with the dataset resolver whenever a domain-tier dataset's Gold lives in its owner's
 * lane: the metric compiled `iceberg.<domain>.gold_<slug>` while `queryable.fqn` (and the real
 * table) was `iceberg.personal_<owner>.gold_<slug>`, so Trino answered SCHEMA_NOT_FOUND.
 *
 * The viewer is the delegated token's SUBJECT (R3) — the identity the query also runs as, so the
 * FQN's schema and the Trino user agree and Trino/OPA apply that viewer's row filters and masks.
 */
function metricReadTarget(dataset: Dataset, token: DelegatedToken): string {
  const resolved = builtLayerFqn(dataset, { id: token.sub, domains: token.domains }, 'gold');
  if (!resolved) {
    const e = new Error(`“${dataset.name}” has no built layer to compute a metric from yet — build its Gold first.`) as Error & { status?: number };
    e.status = 409;
    throw e;
  }
  return resolved.fqn;
}

/**
 * The offline-mock rows: a tiny region-partitioned table that ENFORCES the security
 * context exactly like Trino/OPA would, so the RLS demo is real offline. Deterministic
 * value per (member, region) so numbers are stable + the agent path agrees.
 */
function mockRows(spec: ExploreSpec, ctx: Record<string, unknown>): Record<string, unknown>[] {
  const REGIONS = ['DE', 'FR', 'US'];
  const valueOf = (member: string, region: string) => {
    const s = `${member}:${region}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h % 90000) + 10000;
  };
  const member = spec.member;
  const viewerRegion = ctx.region as string | undefined;
  const regions = viewerRegion ? REGIONS.filter((r) => r === viewerRegion) : REGIONS;
  const regionDim = spec.dimensions.find((d) => d.endsWith('.region'));
  if (regionDim) return regions.map((r) => ({ [regionDim]: r, [member]: valueOf(member, r) }));
  const total = regions.reduce((sum, r) => sum + valueOf(member, r), 0);
  return [{ [member]: total }];
}

/**
 * REVIEW M-4. A SERVED cumulative metric still counts BUCKETS, not calendar units.
 *
 * `windowFrame` emits a `ROWS BETWEEN n PRECEDING AND CURRENT ROW` frame over the bucketed series,
 * so a day with no rows produces no bucket and the window silently trails the last n PRESENT days
 * instead of the last n calendar days. The time spine is generated
 * (`models/os/os_time_spine_day.sql`) but the compiler does not join to it yet, so the honest thing
 * is to say so ON the number — a refusal would remove a number people use today, and silence would
 * let a gap-bearing series read as a calendar window.
 *
 * The existing warning keeps its place at the FRONT: the loud-degradation precedence (outage >
 * unresolved member > dropped slice dimension) is the warning authority, and this caveat is
 * additive to it, never a replacement.
 */
function windowWarning(measure: Measure, spec: ExploreSpec, existing?: string): { warning?: string } {
  if (!measure.rollingWindow) return existing ? { warning: existing } : {};
  const trailing = (measure.rollingWindow.trailing ?? '').trim();
  const caveat =
    trailing === 'unbounded'
      ? 'Running total: this accumulates every time bucket present in the series. A period with no rows produces no bucket, so the series has no zero-filled gaps — the generated time spine (models/os/os_time_spine_day.sql) is not joined to yet.'
      : `Trailing window: the frame counts time BUCKETS, not calendar units, so a period with no rows does not contribute a zero and the window trails the last ${trailing.split(' ')[0] || 'n'} buckets PRESENT in the data. For a dense series these are the same; for a sparse one they are not. The generated time spine (models/os/os_time_spine_day.sql) is not joined to yet.`;
  void spec;
  return { warning: existing ? `${existing}\n${caveat}` : caveat };
}

export type ExploreServerResult = {
  member: string;
  rows: Record<string, unknown>[];
  securityContext: Record<string, unknown>;
  sql: string;
  mode: ExploreMode;
  /** True when the metric compiles but has no number for this slice yet (a window metric
   *  needs a time dimension) — a soft "pending", never a fabricated value. */
  pending?: boolean;
  /** Set WITH `pending` — the TYPED, NAMED reason the OS compiler served no number (M6). */
  refusal?: ServeRefusal;
  /** True on a real deployment when the semantic layer is unreachable — no number is
   *  returned (rows: []) rather than a fabricated one. The UI shows an honest outage. */
  unavailable?: boolean;
  /** LOUD degradation notice (Northpeak fix): requested slice members the view does not
   *  expose were dropped from the query — the result is NOT sliced as asked. */
  warning?: string;
  droppedMembers?: string[];
  /**
   * The QUERY-TOOL's own truncation, passed straight through (review C-10, filed by stream C).
   *
   * The serve SQL carries the slice's `LIMIT`, but the query tool has a SECOND, lower ceiling of
   * its own (`QUERY_MAX_ROWS`). When that one clips the result, the rows are the FIRST n and not a
   * sample — and this layer used to drop the fact on the floor, so a consumer that summed the rows
   * presented a total over an unknown fraction of the groups with nothing to warn it. The three
   * fields are the query tool's, verbatim, so a surface can show its sentence rather than invent
   * one.
   */
  truncated?: boolean;
  rowLimit?: number;
  message?: string;
};

export async function exploreMetric(
  dataset: Dataset,
  measure: Measure,
  token: DelegatedToken,
  slice: {
    dimensions?: string[];
    timeDimension?: string;
    granularity?: Granularity;
    limit?: number;
    /** Equality filters (bare column names) — the drill-down shape; reconciled + WHERE'd
     *  by the explorer (a filter on a non-member is dropped LOUDLY, never silently). */
    filters?: { column: string; values: string[] }[];
  } = {},
): Promise<ExploreServerResult> {
  const spec = exploreSpec(dataset, measure, slice);
  const live = await liveMetricsReachable();
  // HONESTY GATE: on a real deployment, an unreachable Trino is an outage — return no
  // number (never the hash-seeded offline-mock, which is what surfaced fabricated KPIs
  // like 286,936). Local/teaching keeps the mock so the laptop flow still runs.
  if (!live && metricsMustBeLive()) {
    return {
      member: spec.member,
      rows: [],
      securityContext: {},
      sql: dropToSql(spec),
      mode: 'unavailable',
      unavailable: true,
      warning:
        'Metric temporarily unavailable — the governed lakehouse (Trino) is unreachable, so this number cannot be computed right now. No value is shown rather than an estimated one. Retry shortly; if it persists, the Trino service needs attention.',
    };
  }
  const base = {
    member: spec.member,
    sql: dropToSql(spec),
    mode: (live ? 'live' : 'offline-mock') as ExploreMode,
    // NEVER a silent de-dimension (Northpeak fix): members the view doesn't expose were
    // dropped from the query — say so on every result shape this function returns.
    ...(spec.dropped && spec.dropped.length > 0
      ? {
          droppedMembers: spec.dropped,
          warning: `Not sliced by ${spec.dropped.map((d) => `“${d}”`).join(', ')} — ${spec.dropped.length === 1 ? 'this member is' : 'these members are'} not exposed on the governed view (the dataset's domain table may need re-promotion, or the column isn't documented on the Gold).`,
        }
      : {}),
  };
  if (live) {
    // THE read path: compute the number as ONE governed Trino SELECT over the physical table
    // `get_dataset.queryable` names for this viewer, under the viewer's delegated identity (R3 — Trino/OPA row/column
    // security). Serves saved AND unsaved metrics alike, so a personal-dataset metric (read
    // AS its owner from the personal lane) works. Honestly labelled 'live (sql)'.
    const identities = propagate(token); // throws if the token isn't user-delegated (R2/R3)
    const readTarget = metricReadTarget(dataset, token);
    const sql = previewTrinoSql(dataset, measure, spec, readTarget);
    if (!sql) {
      // No faithful SQL form for this slice. A rolling-window / running-total measure serves
      // as governed SQL but REQUIRES a time dimension + granularity — a window with
      // no series, or an inexpressible trailing frame, has no honest number, so we return an
      // explicit pending with a clear reason rather than a fabricated value.
      // A TYPED, NAMED refusal (M6) — the code, the dbt metric type and the reason, so the UI and
      // an MCP client can both say WHY there is no number instead of showing a blank tile.
      const refusal = serveRefusal(dataset, measure, spec)!;
      return {
        ...base,
        rows: [],
        securityContext: identities.securityContext,
        pending: true,
        refusal,
        warning: refusal.reason,
      };
    }
    // Run AS the delegated token's SUBJECT (R3 — the viewer's uid). When the resolved table is
    // in the viewer's own `personal_<uid>` lane the subject owns it (OPA `is_owned_personal`);
    // otherwise the subject's groups carry the domain membership OPA gates the domain mart on.
    let result: Awaited<ReturnType<typeof queryRun>>;
    try {
      result = await queryRun(sql, identities.trino.user, routeForTable(readTarget, 'metrics', [dataset.domain]));
    } catch (e) {
      // A governed dataset whose DOMAIN copy is missing: a typed not_built naming it — never a
      // fallback to the owner's lane (their workspace, which may hold a different table).
      if (isGoverned(dataset) && isMissingTableError(e)) throw new NotBuiltError(dataset.id, dataset.name, readTarget);
      throw e;
    }
    return {
      ...base,
      sql,
      mode: 'live (sql)',
      rows: sqlRowsToExploreRows(result.columns, result.rows, spec),
      securityContext: identities.securityContext,
      // Review C-10: the query tool's OWN ceiling, not the slice's LIMIT. Dropping these made a
      // clip below the metric's own bound invisible to every consumer.
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.rowLimit !== undefined ? { rowLimit: result.rowLimit } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...windowWarning(measure, spec, base.warning),
    };
  }
  // Not live: the honest offline-MOCK (local/teaching only — the honesty gate above already
  // returned 'unavailable' on a real deployment). The in-memory rows enforce the same RLS.
  const { securityContext } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  return { ...base, rows: mockRows(spec, securityContext), securityContext, ...windowWarning(measure, spec, base.warning) };
}

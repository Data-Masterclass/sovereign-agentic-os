/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../data/index.ts';
import { type DelegatedToken, propagate } from '../data/identity.ts';
import { dimensionMember, measureMember } from './model.ts';
import { goldMartFqn, viewMembers } from '../data/metrics.ts';

/**
 * The metric explorer — pick a metric + dimensions to slice, no SQL, per-viewer RLS.
 *
 * R3 is the whole point here: the query is resolved at Cube under the VIEWER'S identity
 * (`securityContext`), never a shared service identity, so two people exploring the same
 * metric see DIFFERENT rows. We derive the security context from the same delegated
 * token the agent `metrics` tool uses ({@link propagate}), so the explorer and the agent
 * are the same row-filtered query. Pure: the Cube load is injected, unit-tested with an
 * in-memory executor that honours the security context.
 *
 * Analysts can `dropToSql` to the Cube SQL API / Trino for ad-hoc work beyond the metric.
 */

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type ExploreSpec = {
  /** The canonical measure member to chart (the single source of the number). */
  member: string;
  /** Dimension members to slice by. */
  dimensions: string[];
  /** Optional time dimension + granularity. */
  timeDimension?: string;
  granularity?: Granularity;
  limit?: number;
  /** LOUD-degradation record (Northpeak fix): slice members the view does NOT expose,
   *  dropped from the query so Cube doesn't 400 — but REPORTED, never silent. A non-empty
   *  list means the rendered result is NOT sliced the way the caller asked. */
  dropped?: string[];
};

/** Build an ExploreSpec from a dataset + measure + chosen slice (UI convenience). */
export function exploreSpec(
  dataset: Dataset,
  measure: Measure,
  slice: { dimensions?: string[]; timeDimension?: string; granularity?: Granularity; limit?: number } = {},
): ExploreSpec {
  // Reconcile against the view's member set: a slice on a non-member (classically the
  // dataset PRIMARY KEY, which is a cube dimension but excluded from the view) would 400
  // at Cube, so it is dropped from the QUERY — but NEVER silently (Northpeak fix): every
  // dropped member is recorded on `spec.dropped` so the caller must surface an honest
  // "not sliced by X" warning instead of rendering a de-dimensioned chart as if it were fine.
  const members = viewMembers(dataset);
  const dims = (slice.dimensions ?? []).filter((d) => members.has(d));
  const droppedDims = (slice.dimensions ?? []).filter((d) => !members.has(d));
  const timeOk = slice.timeDimension && members.has(slice.timeDimension) ? slice.timeDimension : undefined;
  const droppedTime = slice.timeDimension && !timeOk ? [slice.timeDimension] : [];
  const dropped = [...droppedDims, ...droppedTime];
  return {
    member: measureMember(dataset, measure),
    dimensions: dims.map((d) => dimensionMember(dataset, d)),
    timeDimension: timeOk ? dimensionMember(dataset, timeOk) : undefined,
    granularity: timeOk ? slice.granularity : undefined,
    limit: slice.limit,
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

/** A Cube REST `load` query (the shape Cube's /v1/load accepts). */
export type CubeQuery = {
  measures: string[];
  dimensions: string[];
  timeDimensions?: { dimension: string; granularity: Granularity }[];
  limit: number;
};

export function buildCubeQuery(spec: ExploreSpec): CubeQuery {
  return {
    measures: [spec.member],
    dimensions: spec.dimensions,
    timeDimensions:
      spec.timeDimension && spec.granularity
        ? [{ dimension: spec.timeDimension, granularity: spec.granularity }]
        : undefined,
    limit: spec.limit ?? 100,
  };
}

/** The injected Cube executor — resolves a query UNDER a security context (RLS at Cube). */
export type CubeExecutor = {
  load(query: CubeQuery, securityContext: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[] }>;
};

export type ExploreResult = {
  member: string;
  securityContext: Record<string, unknown>;
  rows: Record<string, unknown>[];
};

/**
 * Explore a metric under the viewer's delegated identity. R3: the security context is
 * derived from the token (not a service account — {@link propagate} asserts delegation),
 * so the row filter is the viewer's. Two tokens → two security contexts → two row sets.
 */
export async function explore(spec: ExploreSpec, token: DelegatedToken, exec: CubeExecutor): Promise<ExploreResult> {
  const { cube } = propagate(token); // throws if the token isn't user-delegated (R2/R3)
  const { rows } = await exec.load(buildCubeQuery(spec), cube.securityContext);
  return { member: spec.member, securityContext: cube.securityContext, rows };
}

/**
 * Drop to SQL — the analyst escape hatch. Cube exposes each view as a SQL table (the SQL
 * API, Postgres protocol); the same member is `"View"."measure"`, so the SQL the analyst
 * sees still resolves the governed metric (and Cube still applies RLS). For ad-hoc work
 * beyond the metric they can point this at Trino.
 */
export function dropToSql(spec: ExploreSpec): string {
  const [view, measure] = spec.member.split('.');
  const dims = spec.dimensions.map((d) => `"${d.split('.')[1]}"`);
  const select = [...dims, `"${measure}"`].join(', ');
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  return `-- Cube SQL API (RLS still applies). Repoint at Trino for ad-hoc beyond the metric.\nSELECT ${select}\nFROM "${view}"${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}

// ------------------------------------------------- pre-save preview (Trino) ----

/** One measure as a Trino aggregate expression over the gold mart. Guided measure
 *  filters become `FILTER (WHERE …)` (the `{CUBE}.` prefix drops — the mart IS the
 *  cube's table); a ratio (`number`) expands its sibling measures ONE level. Returns
 *  null for shapes with no faithful plain-SQL equivalent (rolling windows / running
 *  totals — those need Cube's time-window machinery and are served after Publish). */
function trinoAggExpr(m: Measure, siblings: Measure[]): string | null {
  if (m.rollingWindow) return null;
  const filter = m.filters?.length
    ? ` FILTER (WHERE ${m.filters.map((f) => f.sql.replaceAll('{CUBE}.', '')).join(' AND ')})`
    : '';
  switch (m.type) {
    case 'count': return `COUNT(*)${filter}`;
    case 'count_distinct': return `COUNT(DISTINCT ${m.sql})${filter}`;
    case 'count_distinct_approx': return `approx_distinct(${m.sql})${filter}`;
    case 'sum': case 'avg': case 'min': case 'max':
      return `${m.type.toUpperCase()}(${m.sql})${filter}`;
    case 'number': {
      // Ratio over sibling measures: `1.0 * {a} / {b}` → each `{x}` becomes x's own
      // aggregate expression (one level deep — a ratio of ratios has no SQL preview).
      const refs = [...m.sql.matchAll(/\{([a-z0-9_]+)\}/g)].map((x) => x[1]);
      if (refs.length === 0) return null;
      let sql = m.sql;
      for (const r of refs) {
        const sib = siblings.find((s) => s.name === r && s.type !== 'number');
        const expr = sib ? trinoAggExpr(sib, siblings) : null;
        if (!expr) return null;
        sql = sql.replaceAll(`{${r}}`, `(${expr})`);
      }
      return sql;
    }
    default: return null;
  }
}

/**
 * The PRE-SAVE preview SQL: the same number the metric will produce, computed as one
 * governed Trino SELECT over the dataset's gold mart. Used when the draft measure is
 * not yet delivered to Cube (nothing to resolve there — the sidecar only ships
 * PERSISTED metrics), so the preview never queries Cube for a member that can't
 * exist. Returns null when the measure has no faithful plain-SQL form (rolling
 * window / running total) — those preview only after Publish.
 */
export function previewTrinoSql(dataset: Dataset, measure: Measure, spec: ExploreSpec): string | null {
  const agg = trinoAggExpr(measure, dataset.measures);
  if (!agg) return null;
  const dims = spec.dimensions.map((d) => d.split('.')[1]);
  const timeCol = spec.timeDimension && spec.granularity ? spec.timeDimension.split('.')[1] : null;
  const groupSelect = [
    ...dims.map((c) => `"${c}"`),
    ...(timeCol ? [`date_trunc('${spec.granularity}', "${timeCol}") AS "${timeCol}"`] : []),
  ];
  const select = [...groupSelect, `${agg} AS "${measure.name}"`].join(', ');
  const groupBy = groupSelect.length
    ? `\nGROUP BY ${groupSelect.map((_, i) => i + 1).join(', ')}`
    : '';
  // NO comment header: this SQL is EXECUTED via the governed query path (queryRun),
  // which rejects any statement containing `--` or `/* */`. Explanatory comments live
  // only on the display-side dropToSql above, which is never executed.
  return `SELECT ${select}\nFROM ${goldMartFqn(dataset)}${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}

/** Map a governed-SQL result (column names + string rows) onto the SAME row shape the
 *  Cube path returns (keys = full `View.member` strings), so the pre-save preview and
 *  the post-save Cube result render identically. The measure column is numeric. */
export function sqlRowsToExploreRows(columns: string[], rows: string[][], spec: ExploreSpec): Record<string, unknown>[] {
  const measureLeaf = spec.member.split('.')[1];
  const memberFor = (col: string): string => {
    if (col === measureLeaf) return spec.member;
    if (spec.timeDimension && spec.timeDimension.split('.')[1] === col) return spec.timeDimension;
    return spec.dimensions.find((d) => d.split('.')[1] === col) ?? col;
  };
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = r[i];
      const asNumber = Number(v);
      out[memberFor(c)] = c === measureLeaf && v !== null && v !== '' && Number.isFinite(asNumber) ? asNumber : v;
    });
    return out;
  });
}

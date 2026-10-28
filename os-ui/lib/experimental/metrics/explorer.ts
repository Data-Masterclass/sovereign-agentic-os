/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, RollingWindow } from '../data/index.ts';
import { dimensionMember, measureMember } from './model.ts';
import { goldMartFqn, viewMembers } from '@/lib/experimental/data';

/**
 * The metric explorer — pick a metric + dimensions to slice, no SQL, per-viewer RLS.
 *
 * R3 is the whole point here: the query is resolved under the VIEWER'S identity
 * (`securityContext`), never a shared service identity, so two people exploring the same
 * metric see DIFFERENT rows. The live read path is governed Trino SQL run AS the viewer
 * ({@link previewTrinoSql}); the same delegated token drives the agent `metrics` tool, so
 * the explorer and the agent are the same row-filtered query. Pure: the slice→spec and
 * spec→SQL compilation is unit-tested without a backend.
 *
 * Analysts can `dropToSql` for ad-hoc work beyond the metric.
 */

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** An equality/IN filter on a dimension member — the drill-down shape ("only rows where
 *  region ∈ {DE}"). Values are matched as-is; numeric-looking values compare unquoted. */
export type ExploreFilter = { member: string; values: string[] };

export type ExploreSpec = {
  /** The canonical measure member to chart (the single source of the number). */
  member: string;
  /** Dimension members to slice by. */
  dimensions: string[];
  /** Optional time dimension + granularity. */
  timeDimension?: string;
  granularity?: Granularity;
  limit?: number;
  /** Equality filters narrowing the rows BEFORE aggregation (drill-down). */
  filters?: ExploreFilter[];
  /** LOUD-degradation record (Northpeak fix): slice members the view does NOT expose,
   *  dropped from the query (they are not view members) — but REPORTED, never silent. A non-empty
   *  list means the rendered result is NOT sliced the way the caller asked. */
  dropped?: string[];
};

/** Build an ExploreSpec from a dataset + measure + chosen slice (UI convenience). */
export function exploreSpec(
  dataset: Dataset,
  measure: Measure,
  slice: {
    dimensions?: string[];
    timeDimension?: string;
    granularity?: Granularity;
    limit?: number;
    /** Equality filters (bare column names, like `dimensions`) — the drill-down shape. */
    filters?: { column: string; values: string[] }[];
  } = {},
): ExploreSpec {
  // Reconcile against the view's member set: a slice on a non-member (classically the
  // dataset PRIMARY KEY, which is a model dimension but excluded from the view) is not
  // servable, so it is dropped from the QUERY — but NEVER silently (Northpeak fix): every
  // dropped member is recorded on `spec.dropped` so the caller must surface an honest
  // "not sliced by X" warning instead of rendering a de-dimensioned chart as if it were fine.
  const members = viewMembers(dataset);
  const dims = (slice.dimensions ?? []).filter((d) => members.has(d));
  const droppedDims = (slice.dimensions ?? []).filter((d) => !members.has(d));
  const timeOk = slice.timeDimension && members.has(slice.timeDimension) ? slice.timeDimension : undefined;
  const droppedTime = slice.timeDimension && !timeOk ? [slice.timeDimension] : [];
  // Filters reconcile like dimensions: a filter on a non-member is dropped LOUDLY — a
  // silently unfiltered drill-down would show the wrong (unnarrowed) number.
  const filtersIn = (slice.filters ?? []).filter((f) => f.values.length > 0);
  const filtersOk = filtersIn.filter((f) => members.has(f.column));
  const droppedFilters = filtersIn.filter((f) => !members.has(f.column)).map((f) => f.column);
  const dropped = [...droppedDims, ...droppedTime, ...droppedFilters];
  return {
    member: measureMember(dataset, measure),
    dimensions: dims.map((d) => dimensionMember(dataset, d)),
    timeDimension: timeOk ? dimensionMember(dataset, timeOk) : undefined,
    granularity: timeOk ? slice.granularity : undefined,
    limit: slice.limit,
    ...(filtersOk.length > 0
      ? { filters: filtersOk.map((f) => ({ member: dimensionMember(dataset, f.column), values: f.values })) }
      : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

/**
 * Drop to SQL — the analyst escape hatch: the metric's member as a view-shaped SELECT
 * (`"View"."measure"`), so the SQL the analyst sees still names the governed metric. The
 * executable form is {@link previewTrinoSql} (the compiled SELECT over the physical mart).
 */
export function dropToSql(spec: ExploreSpec): string {
  const [view, measure] = spec.member.split('.');
  const dims = spec.dimensions.map((d) => `"${d.split('.')[1]}"`);
  const select = [...dims, `"${measure}"`].join(', ');
  const groupBy = dims.length ? `\nGROUP BY ${dims.join(', ')}` : '';
  return `-- Governed metric view (RLS applies at Trino). Use the compiled SQL for ad-hoc work beyond the metric.\nSELECT ${select}\nFROM "${view}"${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}

// ------------------------------------------------- pre-save preview (Trino) ----

/** One measure's BASE aggregate expression over the gold mart — the per-row-group
 *  aggregate, IGNORING any rolling window (the window is layered on top by
 *  {@link windowTrinoSql}). Guided measure filters become `FILTER (WHERE …)` (the
 *  `{CUBE}.` placeholder drops — the mart IS the model's table); a ratio (`number`) expands its
 *  sibling measures ONE level. Returns null for a ratio whose siblings have no SQL form. */
function baseAggExpr(m: Measure, siblings: Measure[]): string | null {
  const filter = m.filters?.length
    ? ` FILTER (WHERE ${m.filters.map((f) => f.sql.replaceAll('{CUBE}.', '')).join(' AND ')})`
    : '';
  switch (m.type) {
    case 'count': return `COUNT(*)${filter}`;
    case 'count_distinct': return `COUNT(DISTINCT ${m.sql})${filter}`;
    case 'count_distinct_approx': return `approx_distinct(${m.sql})${filter}`;
    case 'sum': case 'avg':
      // Explicit numeric cast: a Bronze column that skipped a Silver cast reaches Gold
      // as VARCHAR, and Trino refuses avg/sum on it (FUNCTION_NOT_FOUND). CAST — not
      // TRY_CAST — so clean text-typed numbers aggregate correctly, an already-numeric
      // column is unchanged (avg returns double anyway), and a genuinely non-numeric
      // value fails LOUDLY naming itself, never silently skipped.
      return `${m.type.toUpperCase()}(CAST(${m.sql} AS double))${filter}`;
    case 'min': case 'max':
      // No cast: min/max are valid on text/date columns and casting would break their
      // lexicographic/temporal semantics.
      return `${m.type.toUpperCase()}(${m.sql})${filter}`;
    case 'number': {
      // Ratio over sibling measures: `1.0 * {a} / {b}` → each `{x}` becomes x's own
      // aggregate expression (one level deep — a ratio of ratios has no SQL preview).
      const refs = [...m.sql.matchAll(/\{([a-z0-9_]+)\}/g)].map((x) => x[1]);
      if (refs.length === 0) return null;
      let sql = m.sql;
      for (const r of refs) {
        const sib = siblings.find((s) => s.name === r && s.type !== 'number');
        const expr = sib ? baseAggExpr(sib, siblings) : null;
        if (!expr) return null;
        sql = sql.replaceAll(`{${r}}`, `(${expr})`);
      }
      return sql;
    }
    default: return null;
  }
}

/** The WHERE clause for the spec's equality filters ('' when none). Values compare on
 *  `CAST(col AS varchar)` — drill values originate from RENDERED rows (always strings),
 *  so a text compare is faithful for varchar, numeric and date columns alike and can
 *  never hit a Trino type-mismatch. Single quotes escape as ''. */
function filterWhereSql(spec: ExploreSpec): string {
  const filters = spec.filters ?? [];
  if (filters.length === 0) return '';
  const preds = filters.map((f) => {
    const col = f.member.split('.')[1] ?? f.member;
    const vals = f.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    return `CAST("${col}" AS varchar) IN (${vals})`;
  });
  return `\nWHERE ${preds.join(' AND ')}`;
}

/** One measure as a Trino aggregate expression, honouring the rolling-window guard: a
 *  window measure has no PLAIN (non-windowed) aggregate form, so this returns null for it
 *  (the caller layers the window on via {@link windowTrinoSql}). A non-window measure is
 *  exactly its {@link baseAggExpr}. */
function trinoAggExpr(m: Measure, siblings: Measure[]): string | null {
  if (m.rollingWindow) return null;
  return baseAggExpr(m, siblings);
}

/** The window frame + accumulator for a rolling-window measure over the BUCKETED series.
 *  `trailing: 'unbounded'` = a RUNNING TOTAL (cumulative from the first bucket); a finite
 *  `trailing: 'N unit'` = a TRAILING window of the last N buckets. `null` when the window
 *  is not expressible as a faithful ROWS frame (see {@link windowTrinoSql} for the rules). */
function windowFrame(win: RollingWindow, granularity: Granularity): string | null {
  const trailing = (win.trailing ?? '').trim();
  if (!trailing) return null;
  if (trailing === 'unbounded') {
    // Running total: accumulate every bucket up to and including the current one.
    return 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW';
  }
  const m = /^(\d+)\s+(day|week|month|quarter|year)s?$/.exec(trailing);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2];
  // A trailing frame is expressed in BUCKETS, so the window's unit must match the slice
  // granularity — "7 day" trailing over a DAY-bucketed series is 7 buckets. A unit that
  // differs from the granularity (e.g. a "1 month" window on a day-grained slice) has no
  // faithful ROWS-frame form here, so we return null → the caller serves an honest pending
  // with a clear reason rather than a wrong number.
  if (unit !== granularity || amount < 1) return null;
  // N buckets trailing (inclusive of the current) = N-1 preceding rows. NOTE (sparse
  // buckets): the frame counts EXISTING buckets, not calendar units — a series with gaps
  // (a bucket with no rows produces no row) trails the last N PRESENT buckets, which for a
  // dense day-grained gold equals the last N days. This is the honest, date-spine-free
  // choice; a gap-filled spine is deliberately not synthesised.
  return `ROWS BETWEEN ${amount - 1} PRECEDING AND CURRENT ROW`;
}

/**
 * The SERVE SQL for a ROLLING-WINDOW / RUNNING-TOTAL measure (Phase 2). A window measure
 * aggregates the base measure per time bucket, then runs a window accumulator over that
 * bucketed series — SUM for a running total / trailing sum, AVG for a trailing average.
 * Faithful to the measure's `rolling_window`: the frame is over the ORDER BY the time bucket,
 * partitioned by any group-by dimensions.
 *
 * A window measure REQUIRES a time dimension + granularity in the slice (`spec.timeDimension`
 * + `spec.granularity`) — without one there is no series to accumulate, so this returns null
 * and the caller serves an honest pending/unusable answer, never a wrong number. Also null
 * when the base measure has no SQL aggregate (a ratio window), when the accumulator isn't
 * sum/avg, or when the trailing frame isn't expressible (see {@link windowFrame}).
 */
function windowTrinoSql(dataset: Dataset, measure: Measure, spec: ExploreSpec, from: string): string | null {
  const win = measure.rollingWindow;
  if (!win) return null;
  if (!spec.timeDimension || !spec.granularity) return null; // no series → no window
  // Only sum/avg accumulate meaningfully over a series; a windowed count is a windowed sum.
  const accumulator = measure.type === 'avg' ? 'AVG' : measure.type === 'sum' || measure.type === 'count' ? 'SUM' : null;
  if (!accumulator) return null;
  const base = baseAggExpr(measure, dataset.measures);
  if (!base) return null;
  const frame = windowFrame(win, spec.granularity);
  if (!frame) return null;

  const dims = spec.dimensions.map((d) => d.split('.')[1]);
  const timeCol = spec.timeDimension.split('.')[1];
  const bucket = `date_trunc('${spec.granularity}', "${timeCol}")`;
  const partition = dims.length ? `PARTITION BY ${dims.map((c) => `"${c}"`).join(', ')} ` : '';
  const over = `OVER (${partition}ORDER BY ${bucket} ${frame})`;
  // The window accumulates the per-bucket base aggregate: `SUM(SUM(x)) OVER (...)`. Trino
  // evaluates the inner aggregate under the GROUP BY, then the outer window over the groups.
  const groupSelect = [...dims.map((c) => `"${c}"`), `${bucket} AS "${timeCol}"`];
  const select = [...groupSelect, `${accumulator}(${base}) ${over} AS "${measure.name}"`].join(', ');
  const groupBy = `\nGROUP BY ${dims.map((_, i) => i + 1).concat([dims.length + 1]).join(', ')}`;
  return `SELECT ${select}\nFROM ${from}${filterWhereSql(spec)}${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}

/**
 * The metric SERVE SQL (metrics→Trino migration, Phase 1): the number a metric produces,
 * computed as ONE governed Trino SELECT over the dataset's PHYSICAL gold mart. This is now
 * the PRIMARY read path for every metric (saved + unsaved) — the one metric read
 * path — so it must target the TIER-AWARE physical gold FQN: the caller passes `readTarget`
 * (personal `iceberg.personal_<owner>.gold_<slug>` for a personal dataset, the domain
 * `iceberg.<domain>.gold_<slug>` otherwise). The gold FQN's SCHEMA and the Trino session
 * principal must agree (see exploreMetric) — that is why the target is resolved server-side
 * and threaded in, not derived here.
 *
 * A ROLLING-WINDOW / RUNNING-TOTAL measure (Phase 2) is compiled by {@link windowTrinoSql}:
 * it needs a time dimension + granularity in the slice. Returns null only when there is no
 * faithful SQL form (a window measure with no time slice, an unresolvable ratio, an
 * inexpressible trailing frame) — the caller then serves an honest pending, never a wrong number.
 */
export function previewTrinoSql(dataset: Dataset, measure: Measure, spec: ExploreSpec, readTarget?: string): string | null {
  const from = readTarget ?? goldMartFqn(dataset);
  if (measure.rollingWindow) return windowTrinoSql(dataset, measure, spec, from);
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
  return `SELECT ${select}\nFROM ${from}${filterWhereSql(spec)}${groupBy}\nLIMIT ${spec.limit ?? 100}`;
}

/** Map a governed-SQL result (column names + string rows) onto the SAME row shape the
 *  explorer returns (keys = full `View.member` strings), so the pre-save preview and
 *  the post-save result render identically. The measure column is numeric. */
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

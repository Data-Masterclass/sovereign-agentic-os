/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { QueryResult } from '../infra/governed.ts';

/**
 * Pure profiling-SQL generator for the Explore panel (data-tab-plan.md §B2 / T4).
 *
 * It turns a resolved table FQN + its columns (from `DESCRIBE`) into a handful of
 * SINGLE-statement `SELECT`s that the route runs through the governed `queryRun`.
 * Because every statement is a plain read, Trino's OPA plugin applies the caller's
 * row filters + column masks automatically — a masked column simply profiles the
 * masked values. No engine, no service, no policy logic lives here: this module is
 * string-in / string-out so it stays trivially unit-testable (mirrors the other
 * pure lib/data modules — no `server-only`, no network).
 *
 * Identifiers are double-quote escaped and value literals single-quote escaped, so
 * a column name can never break out of its statement (defence-in-depth — the names
 * come from DESCRIBE of an already-resolved FQN, never raw user text).
 */

export type ColumnKind = 'numeric' | 'temporal' | 'boolean' | 'string' | 'other';

/** One column as returned by `DESCRIBE <fqn>` (name + Trino type). */
export type ProfileColumn = { name: string; type: string };

/** Classify a Trino type so we only min/max what has a meaningful range. */
export function classifyType(trinoType: string): ColumnKind {
  const t = (trinoType || '').trim().toLowerCase();
  if (/^(tinyint|smallint|integer|int|bigint|real|double|decimal|numeric)\b/.test(t)) return 'numeric';
  if (/^(date|timestamp|time)\b/.test(t)) return 'temporal';
  if (t === 'boolean') return 'boolean';
  if (/^(varchar|char|varbinary)\b/.test(t)) return 'string';
  return 'other';
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// The deterministic aliases the stats row uses, indexed by column position so two
// columns can never collide (and the route reads values back by these names).
export const ROW_COUNT_ALIAS = 'rc';
export const nullsAlias = (i: number) => `n${i}`;
export const distinctAlias = (i: number) => `d${i}`;
export const minAlias = (i: number) => `mn${i}`;
export const maxAlias = (i: number) => `mx${i}`;

/**
 * One-scan stats: total rows + per-column null count, approx distinct, and
 * (numeric/temporal only) min/max cast to varchar for a uniform string return.
 * Non-ranged columns still emit a NULL min/max so the row shape is uniform.
 * Returns a single `SELECT` statement (no trailing semicolon).
 */
export function statsSql(fqn: string, columns: ProfileColumn[]): string {
  const parts: string[] = [`count(*) as ${ROW_COUNT_ALIAS}`];
  columns.forEach((c, i) => {
    const id = quoteIdent(c.name);
    parts.push(`count(*) - count(${id}) as ${nullsAlias(i)}`);
    parts.push(`approx_distinct(${id}) as ${distinctAlias(i)}`);
    const kind = classifyType(c.type);
    if (kind === 'numeric' || kind === 'temporal') {
      parts.push(`cast(min(${id}) as varchar) as ${minAlias(i)}`);
      parts.push(`cast(max(${id}) as varchar) as ${maxAlias(i)}`);
    } else {
      parts.push(`cast(null as varchar) as ${minAlias(i)}`);
      parts.push(`cast(null as varchar) as ${maxAlias(i)}`);
    }
  });
  return `select ${parts.join(', ')} from ${fqn}`;
}

/**
 * Top-K values per column in ONE statement: a `union all` of per-column grouped
 * counts, windowed to the K most frequent. Rows come back as (col, val, cnt) — all
 * strings, so parsing is trivial and safe. Returns `null` when there are no columns.
 */
export function topValuesSql(fqn: string, columns: ProfileColumn[], k = 5): string | null {
  if (columns.length === 0) return null;
  const branches = columns.map(
    (c) =>
      `select ${quoteLit(c.name)} as col, cast(${quoteIdent(c.name)} as varchar) as val, count(*) as cnt from ${fqn} group by 1, 2`,
  );
  return (
    `select col, val, cnt from (` +
    `select col, val, cnt, row_number() over (partition by col order by cnt desc, val asc) as rn ` +
    `from (${branches.join(' union all ')})` +
    `) where rn <= ${Math.max(1, Math.floor(k))} order by col asc, cnt desc`
  );
}

/** A bounded row preview — a single `SELECT * … LIMIT n` statement. */
export function previewSql(fqn: string, limit = 50): string {
  return `select * from ${fqn} limit ${Math.max(1, Math.floor(limit))}`;
}

// ------------------------------------------------------------- result parsing --

export type ColumnProfile = {
  name: string;
  type: string;
  kind: ColumnKind;
  nulls: number;
  nullPct: number;
  distinct: number;
  min: string | null;
  max: string | null;
  top: { value: string; count: number }[];
};

export type Profile = {
  fqn: string;
  layer: string;
  rowCount: number;
  columns: ColumnProfile[];
  preview: { columns: string[]; rows: string[][] };
  generatedAt: string;
};

/** Parse `DESCRIBE <fqn>` output (columns: Column, Type, …) into ProfileColumns. */
export function parseDescribe(res: QueryResult): ProfileColumn[] {
  return res.rows
    .map((r) => ({ name: String(r[0] ?? '').trim(), type: String(r[1] ?? '').trim() }))
    .filter((c) => c.name.length > 0);
}

function cellByAlias(res: QueryResult, alias: string): string | null {
  const idx = res.columns.findIndex((c) => c.toLowerCase() === alias.toLowerCase());
  if (idx < 0) return null;
  const first = res.rows[0];
  if (!first) return null;
  const v = first[idx];
  return v === undefined || v === null || v === 'None' ? null : String(v);
}

function toInt(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Fold the three raw query results into a single Profile. Kept pure so the route is
 * a thin governed-IO shell and the shaping is unit-tested. `topRes` may be null
 * (skipped/failed) — top values then degrade to empty, never break the profile.
 */
export function assembleProfile(input: {
  fqn: string;
  layer: string;
  columns: ProfileColumn[];
  statsRes: QueryResult;
  topRes: QueryResult | null;
  previewRes: QueryResult;
  generatedAt?: string;
}): Profile {
  const { fqn, layer, columns, statsRes, topRes, previewRes } = input;
  const rowCount = toInt(cellByAlias(statsRes, ROW_COUNT_ALIAS));

  // Group top-values rows (col, val, cnt) by column name.
  const topByCol = new Map<string, { value: string; count: number }[]>();
  if (topRes) {
    for (const r of topRes.rows) {
      const col = String(r[0] ?? '');
      const val = r[1] === undefined || r[1] === null ? '∅' : String(r[1]);
      const cnt = toInt(String(r[2] ?? '0'));
      const list = topByCol.get(col) ?? [];
      list.push({ value: val, count: cnt });
      topByCol.set(col, list);
    }
  }

  const cols: ColumnProfile[] = columns.map((c, i) => {
    const nulls = toInt(cellByAlias(statsRes, nullsAlias(i)));
    return {
      name: c.name,
      type: c.type,
      kind: classifyType(c.type),
      nulls,
      nullPct: rowCount > 0 ? nulls / rowCount : 0,
      distinct: toInt(cellByAlias(statsRes, distinctAlias(i))),
      min: cellByAlias(statsRes, minAlias(i)),
      max: cellByAlias(statsRes, maxAlias(i)),
      top: topByCol.get(c.name) ?? [],
    };
  });

  return {
    fqn,
    layer,
    rowCount,
    columns: cols,
    preview: { columns: previewRes.columns, rows: previewRes.rows },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

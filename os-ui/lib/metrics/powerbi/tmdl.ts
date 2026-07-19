/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cube governed view → Power BI **TMDL semantic-model** generator (#143).
 *
 * ONE-WAY, GENERATED. The Sovereign OS Cube view is the single source of truth for a
 * metric (measures + dimensions + the Gold/Trino binding). This module emits a Power BI
 * **TMDL** (Tabular Model Definition Language) table so a business user in Power BI sees
 * the SAME governed measures/dimensions WITHOUT redefining them. It is regenerated from
 * `/meta` on demand — never a hand-maintained second definition of the metric.
 *
 * WHAT ROUND-TRIPS (Cube → Power BI):
 *   - the table (named after the governed Cube VIEW),
 *   - every named MEASURE, as a DAX expression mirroring the Cube aggregation,
 *   - the measure display FORMAT (Cube `format:` → TMDL `formatString`),
 *   - every gold DIMENSION column (typed),
 *   - the data source binding: a DirectQuery M partition against the governed Cube SQL
 *     endpoint, logging in as the `bi_<domain>` principal so Cube → Trino → OPA RLS
 *     applies on every query (the SAME governed identity the `.pbids` connect uses).
 *
 * WHAT DOES **NOT** ROUND-TRIP (honest scope — no overclaiming):
 *   - NO live write-back. This is Cube → Power BI only; editing the model in Power BI
 *     does NOT change the OS metric. Re-export to pick up OS changes.
 *   - NO full/self-hosted XMLA endpoint. We EMIT the TMDL text; we do not stand up a
 *     Tabular server that Power BI queries over XMLA (decision #141/#143).
 *   - NO per-viewer RLS. The `bi_<domain>` principal is DOMAIN-scoped and shared; every
 *     viewer of a report sees the same domain rows (see lib/powerbi/principal.ts).
 *   - Cube measure `filters` / `rolling_window` are NOT translated into DAX (they stay
 *     enforced server-side inside Cube's view). The DAX measure aggregates the governed,
 *     already-filtered column the view exposes — so the number is still governed, but the
 *     DAX text is a plain aggregation, not a re-encoding of the Cube filter logic.
 *
 * PURE + dependency-free (only sibling pure imports) so it unit-tests against a fake
 * dataset with no I/O, no Cube server, no Power BI SDK.
 */

import type { Dataset, Measure, ColumnDoc } from '../../data/dataset-schema.ts';
import {
  cubeViewName,
  cubeName,
  goldMartFqn,
  inferDimType,
  type CubeDimType,
  type MeasureType,
} from '../../data/metrics.ts';
import { biUserForDomain } from '../../powerbi/principal.ts';

/** Where a generated TMDL model should point Power BI (the governed Cube SQL endpoint). */
export type TmdlEndpoint = {
  /** Cube SQL API host builders connect to (the published ingress host). */
  host: string;
  /** Cube SQL API Postgres-wire port. */
  port: number;
};

/** One Cube measure aggregation → the DAX function that mirrors it. `count` has no source
 *  column (it counts rows), so it maps to `COUNTROWS(<table>)`; everything else aggregates
 *  the measure's `sql` column. `number` is a raw/derived measure — the `sql` is passed
 *  through as the DAX body verbatim (the author already wrote an expression, not an agg). */
export const CUBE_TO_DAX: Record<MeasureType, string> = {
  count: 'COUNTROWS',
  count_distinct: 'DISTINCTCOUNT',
  count_distinct_approx: 'DISTINCTCOUNT', // Power BI has no approx-distinct DAX; exact is the honest mirror
  sum: 'SUM',
  avg: 'AVERAGE',
  min: 'MIN',
  max: 'MAX',
  number: 'PASSTHROUGH', // sentinel — the Cube `sql` IS the expression, emitted verbatim
};

/** Cube dimension type → TMDL column `dataType`. */
const DIM_TO_TMDL: Record<CubeDimType, string> = {
  string: 'string',
  number: 'double',
  time: 'dateTime',
  boolean: 'boolean',
};

/** Cube `format:` (percent/currency/number/…) → a TMDL `formatString`. Unknown/absent
 *  formats emit no format line (Power BI applies its default) — we never invent one. */
function formatString(format: string | undefined): string | null {
  switch ((format || '').toLowerCase()) {
    case 'percent':
      return '0.00%';
    case 'currency':
      return '\\$#,0.00';
    case 'number':
      return '#,0.00';
    default:
      return null;
  }
}

/** TMDL identifiers with a space/special char must be single-quoted. Bare identifiers
 *  (letters/digits/underscore, not starting with a digit) are emitted unquoted. */
function tmdlIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** The DAX body for one Cube measure. The measure aggregates the governed column the Cube
 *  view exposes; `count` counts the table rows; a `number` measure's own `sql` IS the DAX. */
export function daxForMeasure(m: Measure, tableRef: string): string {
  const fn = CUBE_TO_DAX[(m.type as MeasureType) ?? 'count'] ?? 'COUNTROWS';
  if (fn === 'PASSTHROUGH') {
    // A raw/derived measure: the author wrote the expression in Cube `sql`. Emit it as-is
    // (it references the view's columns, which become this table's columns 1:1).
    return (m.sql || '0').trim();
  }
  if (fn === 'COUNTROWS') return `COUNTROWS(${tableRef})`;
  // sum/avg/min/max/distinctcount aggregate the measure's source column. Cube stores the
  // column in `sql`; fall back to the measure name if a bare measure carried no `sql`.
  const col = (m.sql || m.name).trim();
  return `${fn}(${tableRef}[${col}])`;
}

/** One TMDL `measure` block. */
function measureBlock(m: Measure, tableRef: string): string {
  const lines = [`\tmeasure ${tmdlIdent(m.name)} = ${daxForMeasure(m, tableRef)}`];
  const fmt = formatString(m.format);
  if (fmt) lines.push(`\t\tformatString: ${fmt}`);
  // Provenance: this measure is generated from the governed Cube view — not hand-authored.
  lines.push(`\t\t/// Governed by Sovereign OS Cube measure "${m.name}" (${m.type}). One-way, generated.`);
  return lines.join('\n');
}

/** One TMDL `column` block (a governed dimension). */
function columnBlock(c: ColumnDoc): string {
  const dataType = DIM_TO_TMDL[inferDimType(c.name)];
  const lines = [`\tcolumn ${tmdlIdent(c.name)}`, `\t\tdataType: ${dataType}`, `\t\tsourceColumn: ${c.name}`];
  if (c.description) lines.push(`\t\t/// ${c.description.replace(/\r?\n/g, ' ')}`);
  return lines.join('\n');
}

/** The DirectQuery M partition source: a native SELECT against the governed Cube SQL
 *  endpoint, logging in as the `bi_<domain>` principal so Cube → Trino → OPA RLS applies
 *  on every query. DirectQuery (not Import) so the governed filter re-runs live and no
 *  ungoverned snapshot is cached. The password is NEVER embedded — Power BI prompts. */
function partitionBlock(d: Dataset, endpoint: TmdlEndpoint): string {
  const view = cubeViewName(d);
  const user = biUserForDomain(d.domain); // throws on invalid domain
  const server = `${endpoint.host}:${endpoint.port}`;
  // The M expression: PostgreSQL.Database(server, database) with a native query selecting
  // the governed view. `database` is the BI user (self-describing; Cube ignores it for
  // routing but Power BI requires a non-empty value — mirrors lib/powerbi/connection-info).
  const mQuery = [
    'let',
    `    Source = PostgreSQL.Database("${server}", "${user}", [Query="SELECT * FROM ""${view}"""])`,
    'in',
    '    Source',
  ].join('#(lf)');
  return [
    `\tpartition ${tmdlIdent(view)} = m`,
    '\t\tmode: directQuery',
    `\t\tsource = ${JSON.stringify(mQuery)}`,
  ].join('\n');
}

export type TmdlOptions = {
  endpoint: TmdlEndpoint;
};

/**
 * Emit the TMDL `table` definition for a governed dataset's Cube view. This is the whole
 * semantic model an author consumes: a governed table with generated measures + dimensions
 * bound (DirectQuery) to the Cube SQL endpoint as the domain's read-only BI principal.
 */
export function datasetToTmdl(d: Dataset, opts: TmdlOptions): string {
  const view = cubeViewName(d);
  const tableRef = tmdlIdent(view);
  const measureNames = new Set(d.measures.map((m) => m.name));
  // A measure and a dimension may not share a name; the measure wins (mirrors scaffoldCubeYaml).
  const dims = d.columns.filter((c) => !measureNames.has(c.name));
  const measures = d.measures.length
    ? d.measures
    : [{ name: 'count', type: 'count', sql: '' } as Measure];

  const header = [
    '// GENERATED — Power BI TMDL semantic model, emitted ONE-WAY from the Sovereign',
    `// Agentic OS governed Cube view "${view}" (cube ${cubeName(d)}).`,
    `// Source of truth: OS Gold mart ${goldMartFqn(d)} → Cube view → this file.`,
    '// Do NOT hand-edit: re-export from the OS to pick up metric changes. No write-back',
    '// to the OS, and no live XMLA endpoint — this is a generated definition only.',
    '// RLS: DirectQuery as the bi_<domain> principal → Cube → Trino → OPA (domain-scoped).',
  ].join('\n');

  const body = [
    `table ${tableRef}`,
    '',
    ...measures.map((m) => measureBlock(m, tableRef) + '\n'),
    ...dims.map((c) => columnBlock(c) + '\n'),
    partitionBlock(d, opts.endpoint),
    '',
  ].join('\n');

  return `${header}\n\n${body}`;
}

/** The suggested download filename for a dataset's TMDL, e.g. `sales__Orders.tmdl`. */
export function tmdlFilename(d: Dataset): string {
  return `${cubeViewName(d)}.tmdl`;
}

/** A row of the Cube-measure → DAX mapping table, for the export payload + docs. */
export type MeasureMapping = {
  measure: string;
  cubeType: string;
  dax: string;
  formatString: string | null;
};

/** The honest mapping table (Cube measure → DAX) for a dataset — surfaced next to the
 *  download so a consumer can SEE exactly how each governed measure became DAX. */
export function measureMappings(d: Dataset): MeasureMapping[] {
  const tableRef = tmdlIdent(cubeViewName(d));
  const measures = d.measures.length ? d.measures : [{ name: 'count', type: 'count', sql: '' } as Measure];
  return measures.map((m) => ({
    measure: m.name,
    cubeType: m.type,
    dax: daxForMeasure(m, tableRef),
    formatString: formatString(m.format),
  }));
}

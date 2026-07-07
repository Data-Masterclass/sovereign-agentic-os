/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, ColumnDoc } from './dataset-schema.ts';
import { domainSchema } from './store-fqn.ts';

/**
 * The Metric handover to Cube (data-ui-ux.md §"Define a metric — the Cube handover",
 * §"Cube model format"). Metrics are defined on the GOLD version. We follow the
 * `cube_dbt` pattern: the Gold dbt mart is the contract — its columns become Cube
 * DIMENSIONS automatically (cube_dbt maps dbt data_type → Cube dim type; primary_key
 * → a PK dimension); the user only NAMES the MEASURE (+ picks the aggregation/column).
 * A matching dbt `exposure` is emitted per Cube view so the mart→metric edge lands in
 * OpenMetadata automatically (one exposure per view).
 *
 * Pure + tested so the panel preview, the stored artifact and the Build adapter
 * (Phase 6) all generate exactly the same YAML.
 */

export const MEASURE_TYPES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'number'] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];
export type CubeDimType = 'string' | 'number' | 'time' | 'boolean';

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

export function cubeName(d: Dataset): string {
  return slug(d.name);
}

/** The user-facing Cube VIEW name dashboards + the agent metrics tool resolve. */
export function cubeViewName(d: Dataset): string {
  return d.name.replace(/[^A-Za-z0-9]+/g, ' ').trim() || 'View';
}

/** The Gold mart FQN the cube binds to via `sql_table` (the handover contract). */
export function goldMartFqn(d: Dataset): string {
  return `iceberg.${domainSchema(d.domain)}.gold_${slug(d.name)}`;
}

/** cube_dbt's dbt data_type → Cube dimension type. We have no live manifest in kind,
 *  so infer the column's type from its documented name the way cube_dbt would from the
 *  mart schema. The first `*_id` (or the first column) becomes the primary key. */
export function inferDimType(name: string): CubeDimType {
  const n = name.toLowerCase();
  if (/(_at|_date|_ts|_time|date|timestamp)$/.test(n) || n === 'date') return 'time';
  if (/(_id|id|amount|qty|quantity|count|total|net|gross|price|value|num)$/.test(n)) return 'number';
  if (/^(is_|has_)/.test(n)) return 'boolean';
  return 'string';
}

function primaryKeyColumn(columns: ColumnDoc[]): string | null {
  const idCol = columns.find((c) => /(^|_)id$/.test(c.name.toLowerCase()));
  return idCol ? idCol.name : columns[0]?.name ?? null;
}

/** Build the Cube model YAML (cube + view) from the Gold columns + named measures —
 *  the file the Metric step would hand-write only the `measures:` block of. */
export function scaffoldCubeYaml(d: Dataset): string {
  const cube = cubeName(d);
  const pk = primaryKeyColumn(d.columns);
  const dims = d.columns.map((c) => {
    const type = c.name === pk ? 'number' : inferDimType(c.name);
    const pkLine = c.name === pk ? '\n        primary_key: true' : '';
    return `      - name: ${c.name}\n        sql: ${c.name}\n        type: ${type}${pkLine}`;
  });
  const measures = (d.measures.length ? d.measures : [{ name: 'count', type: 'count', sql: '' } as Measure]).map((m) => {
    const sqlLine = m.sql && m.type !== 'count' ? `\n        sql: ${m.sql}` : '';
    return `      - name: ${m.name}\n        type: ${m.type}${sqlLine}`;
  });
  const includes = [...d.measures.map((m) => m.name), ...d.columns.filter((c) => c.name !== pk).map((c) => c.name)];
  return [
    'cubes:',
    `  - name: ${cube}`,
    `    sql_table: ${goldMartFqn(d)}        # the dbt Gold mart (cube_dbt contract)`,
    '    measures:',
    ...measures,
    '    dimensions:',
    ...dims,
    '',
    'views:',
    `  - name: ${cubeViewName(d)}`,
    '    cubes:',
    `      - join_path: ${cube}`,
    `        includes: [${includes.join(', ')}]`,
    '',
  ].join('\n');
}

/** One dbt `exposure` per Cube view — rides in on the dbt artifacts so the
 *  mart→metric edge appears in OpenMetadata automatically (data-ui-ux.md §C). */
export function scaffoldExposureYaml(d: Dataset): string {
  const s = slug(d.name);
  return [
    'exposures:',
    `  - name: ${s}_metrics`,
    '    type: analysis',
    `    label: ${cubeViewName(d)} metrics`,
    '    depends_on:',
    `      - ref('mart_${s}')`,
    '    owner:',
    `      name: ${d.owner}`,
    `    description: Cube view "${cubeViewName(d)}" + the agent metrics tool resolve here.`,
    '',
  ].join('\n');
}

/** A minimal Superset bundle on the Cube view (dataset + a chart) — imported via the
 *  Superset API on Build. Database Service Name = the query service (handover contract,
 *  so OM captures dashboard→mart lineage). */
export function scaffoldDashboardBundle(d: Dataset): string {
  const view = cubeViewName(d);
  const firstMeasure = d.measures[0]?.name ?? 'count';
  return JSON.stringify(
    {
      dashboard: `${view} Overview`,
      database_service_name: 'trino',
      dataset: { name: view, schema: 'cube', sql: `SELECT * FROM "${view}"` },
      charts: [{ name: `${view} — ${firstMeasure}`, viz_type: 'big_number_total', metric: firstMeasure }],
      depends_on_exposure: `${slug(d.name)}_metrics`,
    },
    null,
    2,
  );
}

export const CUBE_ARTIFACT = (d: Dataset) => `metrics/${slug(d.name)}.cube.yml`;
export const EXPOSURE_ARTIFACT = 'models/exposures.yml';
export const DASHBOARD_ARTIFACT = (d: Dataset) => `dashboards/${slug(d.name)}.json`;

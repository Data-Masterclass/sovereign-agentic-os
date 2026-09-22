/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, ColumnDoc } from './dataset-schema.ts';
import { physicalSlug } from './store-fqn.ts';
import { cubeName, goldOutputColumns, inferDimType } from './metrics.ts';

/**
 * The MetricFlow-style SEMANTIC DECLARATION artifact (Phase 1 of the Cube→Trino
 * migration). A metric is now a VIRTUAL DECLARATION, not a Cube registration: the dbt
 * MetricFlow YAML shape (`semantic_models:` + `metrics:`) is the PORTABLE contract, and
 * our own compiler (previewTrinoSql) serves it as governed Trino SQL. It does NOT need to
 * be executed by MetricFlow in this phase — it is the honest, tool-agnostic statement of
 * what each metric means, emitted alongside the (Cube-only, dashboards-bound) cube YAML.
 *
 * Faithful to the dbt MetricFlow schema:
 *   - ONE semantic_model per dataset, `model:` a dbt `ref('mart_<slug>')` to the gold mart;
 *   - entities: the primary key (the same PK the cube scaffold picks);
 *   - dimensions: every non-PK gold OUTPUT column (join-aware truth), time columns typed
 *     as `time` with a `day` grain (mirrors inferDimType — the cube dim-type inference);
 *   - measures: one per named aggregate measure (MetricFlow `agg` + `expr`);
 *   - metrics: one `simple` metric per aggregate measure, one `derived` metric per ratio.
 *
 * Pure + unit-tested (mirrors scaffoldCubeYaml) so the panel preview, the stored artifact
 * and any future compiler all read exactly the same declaration.
 */

/** MetricFlow `agg` for a measure aggregation. Only faithful shapes map — a rolling
 *  window / running total (Cube-served until Phase 2) and an approx-distinct have no
 *  plain MetricFlow measure, so they are declared as metrics without a base measure. */
const AGG_OF: Partial<Record<Measure['type'], string>> = {
  count: 'count',
  count_distinct: 'count_distinct',
  sum: 'sum',
  avg: 'average',
  min: 'min',
  max: 'max',
};

/** Is this measure a plain aggregate with a faithful MetricFlow `measure` block? A ratio
 *  (`number`) is a metric OVER measures (derived), not a measure itself; an approx-distinct
 *  and a rolling window have no portable measure form yet — those become derived/annotated. */
function isSimpleMeasure(m: Measure): boolean {
  return !m.rollingWindow && AGG_OF[m.type] !== undefined;
}

function primaryKeyColumn(columns: ColumnDoc[]): string | null {
  const idCol = columns.find((c) => /(^|_)id$/.test(c.name.toLowerCase()));
  return idCol ? idCol.name : columns[0]?.name ?? null;
}

/** The MetricFlow `type` for a gold dimension column (time vs categorical), reusing the
 *  SAME inference the cube scaffold uses so the two declarations never drift. */
function mfDimType(name: string): 'time' | 'categorical' {
  return inferDimType(name) === 'time' ? 'time' : 'categorical';
}

/** One MetricFlow measure block for an aggregate measure. `count` needs no expr (COUNT(*)),
 *  every other agg carries the column expr. Non-simple measures never reach here. */
function measureBlock(m: Measure): string[] {
  const agg = AGG_OF[m.type]!;
  const out = [`      - name: ${m.name}`, `        agg: ${agg}`];
  if (m.type !== 'count' && m.sql) out.push(`        expr: ${m.sql}`);
  return out;
}

/** The referenced base-measure names of a ratio (`number`) measure (`{a}` / `{b}`). */
function ratioRefs(m: Measure): string[] {
  return [...m.sql.matchAll(/\{([a-z0-9_]+)\}/g)].map((x) => x[1]);
}

/**
 * Build the MetricFlow-style semantic YAML for a dataset (one file per dataset). Faithful
 * to the dbt MetricFlow schema — a portable declaration our compiler serves as Trino SQL.
 */
export function scaffoldSemanticYaml(d: Dataset): string {
  const cols = goldOutputColumns(d);
  const pk = primaryKeyColumn(cols);
  const measureNames = new Set(d.measures.map((m) => m.name));
  // Dimensions = non-PK gold columns that don't collide with a measure name (a measure and
  // a dimension may not share a name — the same rule the cube scaffold applies).
  const dimCols = cols.filter((c) => c.name !== pk && !measureNames.has(c.name));

  const model = cubeName(d); // the same frozen, (possibly) domain-namespaced identity
  const lines: string[] = ['semantic_models:', `  - name: ${model}`, `    model: ref('mart_${physicalSlug(d)}')`];

  // entities — the primary key, so a metric can be joined/grained on it.
  lines.push('    entities:');
  if (pk) lines.push(`      - name: ${pk}`, '        type: primary', `        expr: ${pk}`);

  // dimensions — every non-PK gold output column; time columns carry a day grain.
  lines.push('    dimensions:');
  for (const c of dimCols) {
    const type = mfDimType(c.name);
    lines.push(`      - name: ${c.name}`, `        type: ${type}`, `        expr: ${c.name}`);
    if (type === 'time') lines.push('        type_params:', '          time_granularity: day');
  }

  // measures — one per faithful aggregate measure.
  const simple = d.measures.filter(isSimpleMeasure);
  lines.push('    measures:');
  for (const m of simple) lines.push(...measureBlock(m));

  // metrics — a `simple` metric per aggregate measure; a `derived` metric per ratio that
  // references only known base measures (one level — faithful to what the SQL compiler
  // serves). A rolling-window / approx measure has no portable metric here (Phase 2).
  const simpleNames = new Set(simple.map((m) => m.name));
  lines.push('metrics:');
  for (const m of simple) {
    lines.push(`  - name: ${m.name}`, '    type: simple', '    type_params:', `      measure: ${m.name}`);
  }
  for (const m of d.measures) {
    if (m.type !== 'number') continue;
    const refs = ratioRefs(m);
    if (refs.length === 0 || !refs.every((r) => simpleNames.has(r))) continue; // no faithful form
    // MetricFlow `derived`: the ratio expression over its sibling metrics (curly refs →
    // `{{ metric('x') }}` — the portable MetricFlow reference form).
    const expr = refs.reduce((s, r) => s.replaceAll(`{${r}}`, `{{ metric('${r}') }}`), m.sql);
    lines.push(`  - name: ${m.name}`, '    type: derived', '    type_params:', `      expr: "${expr}"`);
  }

  lines.push('');
  return lines.join('\n');
}

/** One semantic declaration file per dataset — `semantic/<base>.yml`, the SAME namespacing
 *  scheme as the cube artifact so a dataset's declarations sit together and never collide. */
export const SEMANTIC_ARTIFACT = (d: Dataset) => `semantic/${cubeName(d)}.yml`;

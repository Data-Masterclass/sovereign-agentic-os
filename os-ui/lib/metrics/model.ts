/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import type { Dataset, Measure } from '../data/dataset-schema.ts';
import { MEASURE_TYPES, type MeasureType, cubeViewName, slug } from '../data/metrics.ts';

/**
 * The Metrics tab owns the FULL "define a measure" experience (Data's Gold step is a
 * handoff into here). A metric is ONE artifact — a Cube `Measure` on the auto-cube the
 * Data tab scaffolds — reachable three ways that MUST converge:
 *
 *   • a friendly FORM (column + aggregation + dimensions),
 *   • the metrics AGENT (a structured proposal from natural language),
 *   • hand-edited Cube YAML.
 *
 * All three produce the SAME {@link Measure} and the SAME canonical MEMBER. The member
 * is the single source of the number: the explorer, Superset dashboards and the agent
 * `metrics` tool all resolve `measureMember(dataset, measure)` — so the BI layer and the
 * agents can never disagree (metric-consistency, proven in consistency.ts).
 *
 * Pure + tested; the cube_dbt scaffolding (dimensions + view) is reused from lib/data
 * read-only, so Data owns the base cube and Metrics owns the measures layer on top.
 */

export type { MeasureType } from '../data/metrics.ts';

/** The friendly form the "Define a metric" panel writes. */
export type MetricForm = {
  /** Human name shown to the user — "Revenue". */
  name: string;
  /** The aggregation (sum/avg/count…). */
  aggregation: MeasureType;
  /** The Gold column aggregated (empty for `count`). */
  column: string;
  /** The dimensions the metric can be sliced by (date/region/product…). */
  dimensions: string[];
};

export class MetricError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'MetricError';
    this.status = status;
  }
}

function isMeasureType(t: string): t is MeasureType {
  return (MEASURE_TYPES as readonly string[]).includes(t);
}

/** The measure's machine name (the Cube member's leaf) — `Revenue` → `revenue`. */
export function measureName(name: string): string {
  return slug(name);
}

/**
 * The CANONICAL member every consumer resolves — `${ViewNoSpaces}.${measure}`. This is
 * byte-for-byte the string the live Cube client (lib/data) builds for the agent
 * `metrics` tool, so define-here / explore-here / chart-in-Superset / ask-the-agent all
 * read the identical number. Changing this formula would split the number — don't.
 */
export function measureMember(dataset: Dataset, measure: Measure): string {
  return `${cubeViewName(dataset).replace(/\s+/g, '')}.${measure.name}`;
}

/** A dimension member on the same view (for slicing in the explorer / charts). */
export function dimensionMember(dataset: Dataset, dimension: string): string {
  return `${cubeViewName(dataset).replace(/\s+/g, '')}.${dimension}`;
}

// ----------------------------------------------------- the three define paths ---

/** FORM → the canonical Measure. */
export function measureFromForm(form: MetricForm): Measure {
  if (!form.name.trim()) throw new MetricError('a metric needs a name');
  if (!isMeasureType(form.aggregation)) throw new MetricError(`unknown aggregation '${form.aggregation}'`);
  if (form.aggregation !== 'count' && !form.column.trim()) {
    throw new MetricError(`${form.aggregation} needs a column to aggregate`);
  }
  return {
    name: measureName(form.name),
    type: form.aggregation,
    sql: form.aggregation === 'count' ? '' : form.column.trim(),
  };
}

/**
 * AGENT → the canonical Measure. The metrics agent returns a STRUCTURED proposal (it
 * does not hand-write SQL); we route it through the exact same builder as the form, so
 * "define revenue as the sum of net_amount" and the form yield the identical artifact.
 */
export type AgentMetricProposal = MetricForm;

export function measureFromAgent(proposal: AgentMetricProposal): Measure {
  return measureFromForm(proposal);
}

/**
 * YAML → the canonical Measure. Parses the `measures:` block a power user hand-edits
 * (the same shape the cube_dbt scaffold emits) and returns the named measure.
 */
export function measureFromYaml(text: string, name?: string): Measure {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new MetricError(`invalid Cube YAML: ${(e as Error).message}`);
  }
  const measures = collectMeasures(doc);
  if (measures.length === 0) throw new MetricError('no measures found in the YAML');
  const want = name ? measureName(name) : measures[0].name;
  const found = measures.find((m) => m.name === want);
  if (!found) throw new MetricError(`measure '${want}' not found in the YAML`);
  return found;
}

function collectMeasures(doc: unknown): Measure[] {
  const cubes = (doc as { cubes?: unknown })?.cubes;
  const out: Measure[] = [];
  if (!Array.isArray(cubes)) return out;
  for (const c of cubes) {
    const ms = (c as { measures?: unknown })?.measures;
    if (!Array.isArray(ms)) continue;
    for (const m of ms) {
      const r = m as Record<string, unknown>;
      const nm = typeof r.name === 'string' ? r.name : '';
      const ty = typeof r.type === 'string' ? r.type : '';
      if (!nm || !isMeasureType(ty)) continue;
      out.push({ name: nm, type: ty, sql: typeof r.sql === 'string' ? r.sql : '' });
    }
  }
  return out;
}

/** Two measures are the SAME artifact iff name+type+sql match (consistency primitive). */
export function sameMeasure(a: Measure, b: Measure): boolean {
  return a.name === b.name && a.type === b.type && (a.sql ?? '') === (b.sql ?? '');
}

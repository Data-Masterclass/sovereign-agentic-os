/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import type { Dataset, Measure, MeasureFilter, RollingWindow } from '../data/dataset-schema.ts';
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

/** The comparison operators the guided (no-code) filter offers. Each compiles to a
 *  governed SQL predicate on the cube (never hand-typed SQL). */
export type FilterOperator = 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte' | 'set' | 'notSet';

/** A single guided filter: aggregate only rows where `column <op> value`. */
export type GuidedFilter = { column: string; operator: FilterOperator; value: string };

/** The display units the guided form offers for a rolling window. */
export type WindowUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** A guided trailing time window (last N units, anchored at the period end). */
export type GuidedWindow = { amount: number; unit: WindowUnit };

/** A ratio (derived `number` measure) over two OTHER measures on the same cube. */
export type GuidedRatio = { numerator: string; denominator: string };

/** The friendly form the "Define a metric" panel writes. The four optional groups are
 *  the richer Cube measure model surfaced as guided (no-code) controls; a form with
 *  none of them set produces exactly the plain `{name,type,sql}` measure it always did. */
export type MetricForm = {
  /** Human name shown to the user — "Revenue". */
  name: string;
  /** The aggregation (sum/avg/count…). */
  aggregation: MeasureType;
  /** The Gold column aggregated (empty for `count` and for ratios). */
  column: string;
  /** The dimensions the metric can be sliced by (date/region/product…). */
  dimensions: string[];
  /** Optional guided filter — count only the rows that match. */
  filter?: GuidedFilter;
  /** Optional running total (cumulative from the beginning of time). */
  runningTotal?: boolean;
  /** Optional trailing time window (mutually exclusive with runningTotal). */
  rollingWindow?: GuidedWindow;
  /** Optional ratio — for `aggregation: 'number'`, the derived measure a/b. */
  ratio?: GuidedRatio;
  /** Optional display format (Cube `format:` — e.g. `currency`, `percent`, `number`). */
  format?: string;
  /** Optional drill-down members exposed for exploration. */
  drillMembers?: string[];
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

/** A value that looks numeric is emitted bare; anything else is single-quoted (with
 *  embedded quotes escaped) so the guided filter is always a valid, injection-safe
 *  predicate the user never has to write by hand. */
function sqlValue(v: string): string {
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`;
}

/** Compile a guided filter into a Cube measure-filter predicate on `{CUBE}`. */
export function filterSql(f: GuidedFilter): string {
  const col = `{CUBE}.${f.column}`;
  switch (f.operator) {
    case 'equals': return `${col} = ${sqlValue(f.value)}`;
    case 'notEquals': return `${col} <> ${sqlValue(f.value)}`;
    case 'gt': return `${col} > ${sqlValue(f.value)}`;
    case 'gte': return `${col} >= ${sqlValue(f.value)}`;
    case 'lt': return `${col} < ${sqlValue(f.value)}`;
    case 'lte': return `${col} <= ${sqlValue(f.value)}`;
    case 'set': return `${col} IS NOT NULL`;
    case 'notSet': return `${col} IS NULL`;
  }
}

/** Compile the guided window controls into a Cube `rolling_window`. */
function windowFor(form: MetricForm): RollingWindow | undefined {
  if (form.runningTotal) return { trailing: 'unbounded' };
  if (form.rollingWindow && form.rollingWindow.amount > 0) {
    return { trailing: `${form.rollingWindow.amount} ${form.rollingWindow.unit}`, offset: 'end' };
  }
  return undefined;
}

/** FORM → the canonical Measure. A plain form yields exactly `{name,type,sql}`; the
 *  optional groups add filters / rolling_window / format / drill_members / a ratio sql. */
export function measureFromForm(form: MetricForm): Measure {
  if (!form.name.trim()) throw new MetricError('a metric needs a name');
  if (!isMeasureType(form.aggregation)) throw new MetricError(`unknown aggregation '${form.aggregation}'`);

  const isRatio = form.aggregation === 'number';
  if (isRatio) {
    if (!form.ratio || !form.ratio.numerator.trim() || !form.ratio.denominator.trim()) {
      throw new MetricError('a ratio needs a numerator and a denominator measure');
    }
  } else if (form.aggregation !== 'count' && !form.column.trim()) {
    throw new MetricError(`${form.aggregation} needs a column to aggregate`);
  }

  const sql = isRatio
    ? `1.0 * {${form.ratio!.numerator.trim()}} / {${form.ratio!.denominator.trim()}}`
    : form.aggregation === 'count' ? '' : form.column.trim();

  const m: Measure = { name: measureName(form.name), type: form.aggregation, sql };

  if (form.filter && form.filter.column.trim()) {
    m.filters = [{ sql: filterSql(form.filter) }];
  }
  const win = windowFor(form);
  if (win) m.rollingWindow = win;
  if (form.format) m.format = form.format;
  if (form.drillMembers && form.drillMembers.length > 0) {
    m.drillMembers = form.drillMembers.filter((d) => d.trim());
  }
  return m;
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
      const mm: Measure = { name: nm, type: ty, sql: typeof r.sql === 'string' ? r.sql : '' };
      // Round-trip the richer fields (Cube emits snake_case; accept both).
      const filtersRaw = r.filters;
      if (Array.isArray(filtersRaw)) {
        const filters = filtersRaw
          .map((f) => (f && typeof (f as { sql?: unknown }).sql === 'string' ? { sql: (f as { sql: string }).sql } : null))
          .filter((f): f is MeasureFilter => f !== null);
        if (filters.length > 0) mm.filters = filters;
      }
      const rw = (r.rollingWindow ?? r.rolling_window) as Record<string, unknown> | undefined;
      if (rw && typeof rw === 'object') {
        const win: RollingWindow = {};
        if (typeof rw.trailing === 'string') win.trailing = rw.trailing;
        if (typeof rw.leading === 'string') win.leading = rw.leading;
        if (rw.offset === 'start' || rw.offset === 'end') win.offset = rw.offset;
        if (win.trailing || win.leading || win.offset) mm.rollingWindow = win;
      }
      if (typeof r.format === 'string' && r.format) mm.format = r.format;
      const dm = (r.drillMembers ?? r.drill_members) as unknown;
      if (Array.isArray(dm)) {
        const members = dm.map((x) => String(x)).filter(Boolean);
        if (members.length > 0) mm.drillMembers = members;
      }
      out.push(mm);
    }
  }
  return out;
}

/** Two measures are the SAME artifact iff every governed field matches (consistency
 *  primitive). The rich fields are compared by their canonical JSON so a filter, window,
 *  format or drill-member difference is a real divergence — the convergence gate then
 *  refuses to persist a form/agent/YAML that don't agree on the WHOLE measure. */
export function sameMeasure(a: Measure, b: Measure): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    (a.sql ?? '') === (b.sql ?? '') &&
    richKey(a) === richKey(b)
  );
}

/** A stable string of the optional rich fields (undefined ≡ absent), for comparison. */
function richKey(m: Measure): string {
  return JSON.stringify({
    filters: m.filters ?? null,
    rollingWindow: m.rollingWindow ?? null,
    format: m.format ?? null,
    drillMembers: m.drillMembers ?? null,
  });
}

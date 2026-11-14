/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OS `Measure` → the typed dbt semantic document, with a REFUSAL for anything dbt or
 *             the OS compiler cannot serve faithfully
 * USER STORY: As a creator I define "Revenue" as the sum of a column and get a real dbt
 *             `metrics:` entry of `type: simple` on a `semantic_models:` measure, in my domain's
 *             dbt project — and if what I defined has no faithful dbt form, I am TOLD, not given
 *             silently different YAML (checklist M1, M5, M6).
 * ARCHITECTURE:
 *   - Pure: (dataset + its dbt model name + a project-wide name allocator) → `{doc, refusals}`.
 *     D6's direction is `Measure` → dbt today and dbt → `Measure` later, so this file is the ONE
 *     bridge and the only place the two vocabularies meet.
 *   - TYPE MAP: OS `count|count_distinct|sum|avg|min|max` → DSI `count|count_distinct|sum|average
 *     |min|max`; `count_distinct_approx` has NO faithful dbt agg, so it emits `count_distinct` plus
 *     `config.meta.os_agg: count_distinct_approx` (D6's one documented exception — dbt's own number
 *     stays exact, the OS compiler keeps `approx_distinct`, and the parity oracle excludes it with
 *     a stated reason); `number` is a metric OVER metrics (`ratio` or `derived`), never a measure.
 *   - NAMES are project-global in dbt: two datasets with a `revenue` measure would make
 *     `dbt parse` fail for the WHOLE domain, so every measure and metric name goes through the
 *     injected allocator, which qualifies a collision with the semantic model's name. The OS
 *     identity never moves: `config.meta.os_metric` / `os_member` carry it on every metric.
 *   - REFUSE, NEVER GUESS. A leading window, an unparseable trailing window, a ratio carrying its
 *     own filter (the OS compiler drops it — `explorer.ts` `baseAggExpr` computes the predicate and
 *     never uses it for `number`), a formula over a metric that is not emitted, a filter outside
 *     the closed grammar: each is a named refusal and NOTHING is emitted for it. Emitting YAML the
 *     OS compiler cannot serve would put a wrong number in a tool an engineer trusts.
 */
import type { ColumnDoc, Dataset, Measure } from '@tabs/data/lib/dataset-schema';
import { goldOutputColumns, inferDimType, modelName, viewName } from '@tabs/data/lib/metrics';
import { physicalSlug } from '@tabs/data/lib/store-fqn';
import type {
  MetricInput,
  SemanticDimension,
  SemanticDoc,
  SemanticMeasure,
  SemanticMetric,
  SemanticModel,
} from '@tabs/data/lib/dbt/semantic/model';
import { METRIC_TIME_WINDOW_RE, SEMANTIC_NAME_RE, type AggregationType, type TimeGranularity } from '@tabs/data/lib/dbt/semantic/spec';
import { isSafeSemanticExpr, isSafeSemanticFilter } from '@tabs/data/lib/dbt/semantic/validate';

/** OS measure type → DSI `AggregationType`. `number` is absent on purpose (it is a metric). */
const AGG_OF: Record<string, AggregationType> = {
  count: 'count',
  count_distinct: 'count_distinct',
  /** No faithful dbt agg — emitted as the exact form plus `config.meta.os_agg` (D6). */
  count_distinct_approx: 'count_distinct',
  sum: 'sum',
  avg: 'average',
  min: 'min',
  max: 'max',
};

export type MetricRefusal = {
  /** The OS measure name that was refused. */
  measure: string;
  reason: string;
};

export type SemanticBuild = { doc: SemanticDoc; refusals: MetricRefusal[] };

/** Reserve a project-global dbt name; a collision is qualified with the semantic model's name. */
export type NameAllocator = (preferred: string, qualifier: string) => string;

/**
 * Measure names and metric names are each project-global in dbt, but they are SEPARATE namespaces
 * — the canonical dbt shape is a measure `order_total` with a `type: simple` metric of the same
 * name — so one allocator per namespace, shared across the whole project.
 */
export type SemanticNames = { measure: NameAllocator; metric: NameAllocator };

function allocator(): NameAllocator {
  const taken = new Set<string>();
  return (preferred, qualifier) => {
    // The sanitised base. REVIEW M-3: every later attempt must be built from THIS, not from the
    // raw `preferred` — a non-identifier name (`Revenue %`) colliding twice used to fall back to
    // `<qualifier>__Revenue %__2`, which is not a dbt identifier and fails `dbt parse` for the
    // whole domain. The numbered fallback is the only path that reaches that case, so it was the
    // one place the sanitising was lost.
    const base = SEMANTIC_NAME_RE.test(preferred) ? preferred : `m_${preferred.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
    let candidate = base;
    if (taken.has(candidate)) candidate = `${qualifier}__${base}`;
    let n = 2;
    while (taken.has(candidate)) candidate = `${qualifier}__${base}__${n++}`;
    taken.add(candidate);
    return candidate;
  };
}

/** A fresh pair of allocators over one project. */
export function semanticNames(): SemanticNames {
  return { measure: allocator(), metric: allocator() };
}

/** The same primary-key inference the cube and the old semantic scaffold use. */
function primaryKeyColumn(columns: ColumnDoc[]): string | null {
  const idCol = columns.find((c) => /(^|_)id$/.test(c.name.toLowerCase()));
  return idCol ? idCol.name : (columns[0]?.name ?? null);
}

/** The ENTITY name every `Dimension('<entity>__<dim>')` reference in this model is prefixed with. */
export function entityNameFor(d: Dataset): string {
  const s = physicalSlug(d);
  return SEMANTIC_NAME_RE.test(s) ? s : `e_${s.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/** The OS `{CUBE}.col op value` predicate shapes, exactly as `metrics/lib/model.ts` emits them. */
const CUBE_NULL_RE = /^\{CUBE\}\.(\w+) IS (NOT )?NULL$/;
const CUBE_CMP_RE = /^\{CUBE\}\.(\w+) (=|<>|>=|<=|>|<) (.+)$/;

/**
 * An OS guided measure filter → the dbt filter syntax, or null when it is not one of the shapes
 * the OS generates (then the whole metric is refused — never emitted with a weaker filter).
 */
export function dbtFilterFor(predicates: string[], entity: string, timeColumns: Set<string>): string | null {
  const parts: string[] = [];
  for (const raw of predicates) {
    const sql = raw.trim();
    const ref = (col: string): string =>
      timeColumns.has(col) ? `{{ TimeDimension('${entity}__${col}', 'day') }}` : `{{ Dimension('${entity}__${col}') }}`;
    const nul = CUBE_NULL_RE.exec(sql);
    if (nul) {
      parts.push(`${ref(nul[1])} IS ${nul[2] ?? ''}NULL`);
      continue;
    }
    const cmp = CUBE_CMP_RE.exec(sql);
    if (!cmp) return null;
    parts.push(`${ref(cmp[1])} ${cmp[2]} ${cmp[3].trim()}`);
  }
  if (!parts.length) return null;
  const filter = parts.join(' AND ');
  return isSafeSemanticFilter(filter) ? filter : null;
}

/** The refs of a ratio / formula measure (`{a}` / `{b}`). */
function refsOf(m: Measure): string[] {
  return [...m.sql.matchAll(/\{([a-z0-9_]+)\}/g)].map((x) => x[1]);
}

/** `1.0 * {a} / {b}` — the canonical two-term ratio `measureFromForm` compiles. */
const RATIO_RE = /^1\.0 \* \{([a-z0-9_]+)\} \/ \{([a-z0-9_]+)\}$/;

/** `cumulative_type_params` for an OS rolling window, or a refusal reason. */
function cumulativeParams(m: Measure): { window?: string } | { grainToDate?: TimeGranularity } | { reason: string } {
  const win = m.rollingWindow!;
  if (win.leading) return { reason: 'a leading window has no dbt metric form (dbt cumulative metrics look backwards only)' };
  const trailing = (win.trailing ?? '').trim();
  if (!trailing) return { reason: 'a rolling window with no trailing duration has no dbt metric form' };
  // An unbounded trailing window IS dbt's all-time cumulative: `type: cumulative` with neither
  // `window` nor `grain_to_date`.
  if (trailing === 'unbounded') return {};
  const parsed = METRIC_TIME_WINDOW_RE.exec(trailing);
  if (!parsed) return { reason: `trailing window '${trailing}' is not dbt's "<count> <granularity>" form` };
  return { window: `${parsed[1]} ${parsed[2]}` };
}

export type SemanticSource = {
  dataset: Dataset;
  /** The dbt model name the semantic model sits on — resolved from the project PLAN, never guessed. */
  model: string;
};

/**
 * Build one dataset's semantic document. `alloc` is shared across the whole project so measure and
 * metric names are globally unique; pass a fresh {@link semanticNames} per generation.
 */
export function semanticDocFor(src: SemanticSource, alloc: SemanticNames = semanticNames()): SemanticBuild {
  const d = src.dataset;
  const refusals: MetricRefusal[] = [];
  const smName = modelName(d);
  const entity = entityNameFor(d);
  const cols = goldOutputColumns(d);
  const pk = primaryKeyColumn(cols);
  const measureNames = new Set(d.measures.map((m) => m.name));
  const dimCols = cols.filter((c) => c.name !== pk && !measureNames.has(c.name));

  const dimensions: SemanticDimension[] = [];
  const timeColumns = new Set<string>();
  for (const c of dimCols) {
    const inferred = inferDimType(c.name);
    const isTime = inferred === 'time';
    if (!SEMANTIC_NAME_RE.test(c.name)) continue; // never interpolate a non-identifier into dbt YAML
    // REVIEW L-1: a numeric FACT column (`net_amount`, `quantity`) is not something anyone groups
    // by, and emitting it as `type: categorical` offers an agent a slice that would produce one
    // row per distinct amount. A key-shaped numeric column (`*_id`) IS a legitimate grouping, so
    // `inferDimType`'s `number` bucket is split on that test rather than dropped wholesale.
    if (inferred === 'number' && !/(^|_)id$/i.test(c.name)) continue;
    const dim: SemanticDimension = { name: c.name, type: isTime ? 'time' : 'categorical' };
    if (c.description) dim.description = c.description;
    if (isTime) {
      dim.type_params = { time_granularity: 'day' };
      timeColumns.add(c.name);
    }
    dim.expr = c.name;
    dimensions.push(dim);
  }
  dimensions.sort((a, b) => a.name.localeCompare(b.name));
  const aggTime = dimensions.find((x) => x.type === 'time')?.name;

  const model: SemanticModel = {
    name: smName,
    model: `ref('${src.model}')`,
    entities: pk && SEMANTIC_NAME_RE.test(pk) ? [{ name: entity, type: 'primary', expr: pk }] : [],
    dimensions,
    measures: [],
  };
  if (d.description) model.description = d.description;
  if (!model.entities.length) model.primary_entity = entity;
  if (aggTime) model.defaults = { agg_time_dimension: aggTime };

  const ordered = [...d.measures].sort((a, b) => a.name.localeCompare(b.name));

  // REVIEW H-1. DSI requires an aggregation time dimension for EVERY measure (`metric_time` is
  // derived from it), on the measure or as the model's `defaults.agg_time_dimension`. A dataset
  // with measures and NO time column can supply neither, and the YAML that resulted failed
  // validation for the WHOLE domain's `dbt parse` — every other dataset's models with it. So each
  // measure is refused BY NAME, with the actionable reason, and nothing is emitted. (The OS still
  // serves those metrics: this is a limit of the dbt artefact, not of the compiler.)
  if (!aggTime) {
    for (const m of ordered) {
      refusals.push({
        measure: m.name,
        reason:
          "the dataset exposes no time dimension, and dbt requires an agg_time_dimension for every measure (metric_time is derived from it) — document a date/timestamp column on the Gold version and the metric becomes a dbt metric",
      });
    }
    refusals.sort((a, b) => a.measure.localeCompare(b.measure));
    return { doc: { semantic_models: [], metrics: [] }, refusals };
  }
  /** OS measure name → the allocated dbt measure name. */
  const measureName = new Map<string, string>();
  /** OS measure name → the allocated dbt METRIC name (every emitted measure gets a metric). */
  const metricName = new Map<string, string>();
  const metrics: SemanticMetric[] = [];

  // Pass 1 — the plain aggregates become measures + their metric (simple, or cumulative).
  for (const m of ordered) {
    if (m.type === 'number') continue;
    const agg = AGG_OF[m.type];
    if (!agg) {
      refusals.push({ measure: m.name, reason: `aggregation '${m.type}' has no dbt AggregationType` });
      continue;
    }
    if (agg !== 'count' && !m.sql.trim()) {
      refusals.push({ measure: m.name, reason: `aggregation '${m.type}' needs a column expression` });
      continue;
    }
    // REVIEW M-2. Refuse an unsafe `expr` HERE, per measure, rather than letting it reach the
    // validator — a document that fails validation is dropped whole in `render.ts`, so one
    // smuggled column would take every other metric on the dataset with it. One bad measure
    // should cost one measure.
    if (agg !== 'count' && !isSafeSemanticExpr(m.sql)) {
      refusals.push({
        measure: m.name,
        reason: `the column expression '${m.sql}' is not in the emitter's closed expr grammar (dbt renders it through Jinja AND as SQL, so quotes, comment markers and template delimiters are refused)`,
      });
      continue;
    }
    let filter: string | undefined;
    if (m.filters?.length) {
      const f = dbtFilterFor(
        m.filters.map((x) => x.sql),
        entity,
        timeColumns,
      );
      if (!f) {
        refusals.push({ measure: m.name, reason: 'the measure filter is not one of the OS guided-filter shapes, so it has no safe dbt filter form' });
        continue;
      }
      filter = f;
    }
    let cumulative: { window?: string; grain_to_date?: TimeGranularity } | undefined;
    if (m.rollingWindow) {
      const c = cumulativeParams(m);
      if ('reason' in c) {
        refusals.push({ measure: m.name, reason: c.reason });
        continue;
      }
      cumulative = 'window' in c && c.window ? { window: c.window } : {};
    }

    const dbtMeasure = alloc.measure(m.name, smName);
    measureName.set(m.name, dbtMeasure);
    const measure: SemanticMeasure = { name: dbtMeasure, agg };
    if (m.description) measure.description = m.description;
    if (agg !== 'count') measure.expr = m.sql;
    if (m.label && m.label !== m.name) measure.label = m.label;
    if (m.type === 'count_distinct_approx') measure.config = { meta: { os_agg: 'count_distinct_approx' } };
    model.measures.push(measure);

    const dbtMetric = alloc.metric(m.name, smName);
    metricName.set(m.name, dbtMetric);
    const metric: SemanticMetric = {
      name: dbtMetric,
      type: cumulative ? 'cumulative' : 'simple',
      type_params: { measure: { name: dbtMeasure } },
    };
    if (cumulative && Object.keys(cumulative).length) metric.type_params.cumulative_type_params = cumulative;
    if (filter) metric.filter = filter;
    if (m.label && m.label !== m.name) metric.label = m.label;
    if (m.description) metric.description = m.description;
    metric.config = { meta: metaFor(d, m) };
    metrics.push(metric);
  }

  // Pass 2 — `number` measures become `ratio` (the canonical two-term shape) or `derived`.
  for (const m of ordered) {
    if (m.type !== 'number') continue;
    if (m.filters?.length) {
      refusals.push({
        measure: m.name,
        reason: "the OS compiler does not apply a ratio's own filter — filter its numerator and denominator metrics instead",
      });
      continue;
    }
    if (m.rollingWindow) {
      refusals.push({ measure: m.name, reason: 'a rolling window over a ratio has no dbt metric form the OS compiler serves' });
      continue;
    }
    const refs = refsOf(m);
    if (!refs.length) {
      refusals.push({ measure: m.name, reason: 'a ratio or formula metric references no other metric' });
      continue;
    }
    const unknown = refs.filter((r) => !metricName.has(r));
    if (unknown.length) {
      refusals.push({ measure: m.name, reason: `references metric(s) not emitted in this document: ${[...new Set(unknown)].sort().join(', ')}` });
      continue;
    }
    const ratio = RATIO_RE.exec(m.sql);
    // The derived form's `expr` is the authored formula with each `{ref}` replaced by its metric
    // name — authored input again, so held to the same closed grammar (review M-2).
    const derivedExpr = m.sql.replace(/\{([a-z0-9_]+)\}/g, (_w, r: string) => metricName.get(r) ?? r);
    if (!ratio && !isSafeSemanticExpr(derivedExpr)) {
      refusals.push({
        measure: m.name,
        reason: `the formula '${m.sql}' compiles to an expression outside the emitter's closed expr grammar`,
      });
      continue;
    }
    const dbtMetric = alloc.metric(m.name, smName);
    metricName.set(m.name, dbtMetric);
    const metric: SemanticMetric = ratio
      ? {
          name: dbtMetric,
          type: 'ratio',
          type_params: { numerator: { name: metricName.get(ratio[1])! }, denominator: { name: metricName.get(ratio[2])! } },
        }
      : {
          name: dbtMetric,
          type: 'derived',
          type_params: {
            // dbt `derived` references its input metrics BY NAME in `expr` (not `{{ metric('x') }}`,
            // which the predecessor emitted and dbt does not accept here).
            expr: derivedExpr,
            metrics: [...new Set(refs)].sort().map((r): MetricInput => ({ name: metricName.get(r)! })),
          },
        };
    if (m.label && m.label !== m.name) metric.label = m.label;
    if (m.description) metric.description = m.description;
    metric.config = { meta: metaFor(d, m) };
    metrics.push(metric);
  }

  metrics.sort((a, b) => a.name.localeCompare(b.name));
  model.measures.sort((a, b) => a.name.localeCompare(b.name));
  refusals.sort((a, b) => a.measure.localeCompare(b.measure));
  return { doc: { semantic_models: [model], metrics }, refusals };
}

/** The OS identity carried on every emitted metric, so the file maps back without a registry. */
function metaFor(d: Dataset, m: Measure): Record<string, string> {
  const meta: Record<string, string> = {
    os_dataset: d.id,
    os_member: `${viewName(d).replace(/\s+/g, '')}.${m.name}`,
    os_metric: `${d.id}.${m.name}`,
  };
  if (m.type === 'count_distinct_approx') meta.os_agg = 'count_distinct_approx';
  if (m.format) meta.os_format = m.format;
  return meta;
}

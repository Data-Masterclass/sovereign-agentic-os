/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Spec validation of the emitted semantic YAML against the pinned dbt spec
 * USER STORY: As a data engineer I want proof that the metric YAML the OS wrote into my repo is
 *             valid for the dbt my cluster runs, because an invalid key or enum fails `dbt parse`
 *             for the WHOLE domain — not just that metric (checklist M2).
 * ARCHITECTURE:
 *   - Pure. Validates the PLAIN object the emitter produces (`semanticDocOut`), so what is checked
 *     is literally what is written, not a parallel model that can drift from it.
 *   - A key/enum WHITELIST (`ALLOWED_KEYS` in `spec.ts`), not a blacklist: an unknown key is a
 *     violation. Cross-object rules too — a `time` dimension needs `type_params.time_granularity`,
 *     `window` and `grain_to_date` are mutually exclusive, a metric's inputs must resolve, every
 *     name must be unique within the document and a plain dbt identifier.
 *   - FILTER GRAMMAR: `filter:` is the one emitted field that keeps its Jinja, so it is held to a
 *     closed grammar — `{{ Dimension('a__b') }} <op> <literal>` or
 *     `{{ TimeDimension('a__b','<grain>') }} <op> <literal>`, and the literal may contain no Jinja
 *     delimiter. Anything else is a violation, because dbt renders YAML through Jinja before
 *     reading it and a user-supplied value inside a template is an injection sink.
 */
import { semanticDocOut, type SemanticDoc } from '@tabs/data/lib/dbt/semantic/model';
import {
  ALLOWED_KEYS,
  METRIC_TIME_WINDOW_RE,
  SEMANTIC_NAME_RE,
  isAggregationType,
  isDimensionType,
  isEntityType,
  isMetricType,
  isTimeGranularity,
} from '@tabs/data/lib/dbt/semantic/spec';

type Plain = Record<string, unknown>;

/** ONE predicate: `{{ Dimension('entity__dim') }} = 'x'`, `{{ TimeDimension('e__t','month') }} >= '2024-01-01'`. */
const PREDICATE_RE =
  /^\{\{ (?:Dimension\('[a-z_][a-z0-9_]*__[a-z_][a-z0-9_]*'\)|TimeDimension\('[a-z_][a-z0-9_]*__[a-z_][a-z0-9_]*', '[a-z]+'\)) \}\}(?: (?:=|<>|>=|<=|>|<) (?:-?\d+(?:\.\d+)?|true|false|'[^'{}%#]*')| IS (?:NOT )?NULL)$/;

/**
 * The grammar an `expr` may use (review M-2). `expr` reaches dbt as SQL *and* through Jinja, and it
 * is the one emitted field whose content comes from authored input — an OS measure's column, or a
 * formula over metric names. So it is held to: identifiers, digits, decimal points, the four
 * arithmetic operators, parentheses, commas, spaces and underscores. No quotes, no semicolons, no
 * comment markers, and no Jinja delimiter of any kind.
 */
export const SAFE_EXPR_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^[A-Za-z0-9_ ().,+\-*/]+$/;

/** Is this `expr` one the emitter is allowed to write? */
export function isSafeSemanticExpr(expr: string): boolean {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  if (/\{\{|\}\}|\{%|%\}|\{#|#\}/.test(expr)) return false;
  if (/--|\/\*|\*\//.test(expr)) return false;
  return SAFE_EXPR_RE.test(expr);
}

/**
 * Is this predicate one the emitter is allowed to write into a dbt `filter:`? A conjunction of
 * closed-grammar predicates, nothing else: no OR, no parentheses, no bare SQL, and no Jinja
 * delimiter inside a literal (dbt renders the YAML through Jinja before reading it).
 */
export function isSafeSemanticFilter(filter: string): boolean {
  if (typeof filter !== 'string' || !filter.trim()) return false;
  const parts = filter.split(' AND ');
  return parts.length > 0 && parts.every((p) => PREDICATE_RE.test(p));
}

function keys(where: string, o: Plain, allowed: readonly string[], out: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`${where}: unknown key '${k}' at DSI 0.8.5`);
}

function name(where: string, v: unknown, out: string[]): void {
  if (typeof v !== 'string' || !SEMANTIC_NAME_RE.test(v)) out.push(`${where}: '${String(v)}' is not a dbt identifier (lower-case letters, digits, underscore)`);
}

function filterOf(where: string, o: Plain, out: string[]): void {
  if (o.filter === undefined) return;
  if (typeof o.filter !== 'string' || !isSafeSemanticFilter(o.filter)) out.push(`${where}: filter '${String(o.filter)}' is not in the emitter's closed filter grammar`);
}

function inputKeys(where: string, v: unknown, allowed: readonly string[], out: string[]): string | null {
  if (typeof v === 'string') {
    name(where, v, out);
    return v;
  }
  if (!v || typeof v !== 'object') {
    out.push(`${where}: expected a name or an object`);
    return null;
  }
  const o = v as Plain;
  keys(where, o, allowed, out);
  name(`${where}.name`, o.name, out);
  filterOf(where, o, out);
  if (o.offset_to_grain !== undefined && !isTimeGranularity(o.offset_to_grain)) out.push(`${where}: offset_to_grain '${String(o.offset_to_grain)}' is not a TimeGranularity`);
  if (o.offset_window !== undefined && !METRIC_TIME_WINDOW_RE.test(String(o.offset_window))) out.push(`${where}: offset_window '${String(o.offset_window)}' is not "<count> <granularity>"`);
  return typeof o.name === 'string' ? o.name : null;
}

/**
 * Validate a semantic document against the pinned spec. Returns every violation, not the first —
 * a generator bug usually shows up as a family of them.
 */
export function validateSemanticDoc(doc: SemanticDoc): string[] {
  const out: string[] = [];
  const plain = semanticDocOut(doc);
  keys('document', plain, ['semantic_models', 'metrics'], out);

  const measureNames = new Set<string>();
  const dimensionNames = new Set<string>();
  const entityNames = new Set<string>();
  const modelNames = new Set<string>();

  for (const sm of (plain.semantic_models ?? []) as Plain[]) {
    const where = `semantic_models[${String(sm.name)}]`;
    keys(where, sm, ALLOWED_KEYS.semanticModel, out);
    name(`${where}.name`, sm.name, out);
    if (modelNames.has(String(sm.name))) out.push(`${where}: duplicate semantic model name`);
    modelNames.add(String(sm.name));
    if (typeof sm.model !== 'string' || !/^ref\('[a-z_][a-z0-9_]*'\)$/.test(sm.model)) {
      out.push(`${where}.model: expected ref('<model>'), got '${String(sm.model)}'`);
    }
    if (sm.defaults !== undefined) keys(`${where}.defaults`, sm.defaults as Plain, ALLOWED_KEYS.defaults, out);

    const localDims = new Set<string>();
    for (const e of (sm.entities ?? []) as Plain[]) {
      const w = `${where}.entities[${String(e.name)}]`;
      keys(w, e, ALLOWED_KEYS.entity, out);
      name(`${w}.name`, e.name, out);
      if (!isEntityType(e.type)) out.push(`${w}.type: '${String(e.type)}' is not one of primary|unique|foreign|natural`);
      entityNames.add(String(e.name));
    }
    const primaries = ((sm.entities ?? []) as Plain[]).filter((e) => e.type === 'primary').length;
    if (primaries === 0 && !sm.primary_entity) out.push(`${where}: no primary entity and no primary_entity property`);
    if (primaries > 1) out.push(`${where}: ${primaries} primary entities (DSI allows one)`);

    for (const d of (sm.dimensions ?? []) as Plain[]) {
      const w = `${where}.dimensions[${String(d.name)}]`;
      keys(w, d, ALLOWED_KEYS.dimension, out);
      name(`${w}.name`, d.name, out);
      if (!isDimensionType(d.type)) out.push(`${w}.type: '${String(d.type)}' is not categorical|time`);
      const tp = d.type_params as Plain | undefined;
      if (tp) keys(`${w}.type_params`, tp, ALLOWED_KEYS.dimensionTypeParams, out);
      if (d.type === 'time') {
        if (!tp || !isTimeGranularity(tp.time_granularity)) out.push(`${w}: a time dimension needs type_params.time_granularity`);
      } else if (tp) {
        out.push(`${w}: type_params on a categorical dimension`);
      }
      if (localDims.has(String(d.name))) out.push(`${w}: duplicate dimension name in this semantic model`);
      localDims.add(String(d.name));
      dimensionNames.add(String(d.name));
    }

    for (const s of (sm.measures ?? []) as Plain[]) {
      const w = `${where}.measures[${String(s.name)}]`;
      keys(w, s, ALLOWED_KEYS.measure, out);
      name(`${w}.name`, s.name, out);
      if (!isAggregationType(s.agg)) out.push(`${w}.agg: '${String(s.agg)}' is not one of the nine DSI AggregationTypes`);
      if (s.agg !== 'count' && !s.expr) out.push(`${w}: agg '${String(s.agg)}' needs an expr`);
      if (s.expr !== undefined && !isSafeSemanticExpr(String(s.expr))) {
        out.push(`${w}.expr: '${String(s.expr)}' is not in the emitter's closed expr grammar (review M-2)`);
      }
      if (s.config !== undefined) keys(`${w}.config`, s.config as Plain, ALLOWED_KEYS.config, out);
      if (measureNames.has(String(s.name))) out.push(`${w}: duplicate measure name — measure names are project-global in dbt`);
      measureNames.add(String(s.name));
      if (localDims.size && s.agg_time_dimension && !localDims.has(String(s.agg_time_dimension))) {
        out.push(`${w}.agg_time_dimension: '${String(s.agg_time_dimension)}' is not a dimension of this semantic model`);
      }
      // REVIEW H-1. DSI requires an aggregation time dimension for EVERY measure — on the measure
      // or as the semantic model's `defaults.agg_time_dimension` — because `metric_time` is
      // derived from it. A dataset with measures and no time column was emitting a model with
      // neither, which fails validation for the WHOLE domain's `dbt parse`, not just that metric.
      const modelDefault = (sm.defaults as Plain | undefined)?.agg_time_dimension;
      if (!s.agg_time_dimension && !modelDefault) {
        out.push(
          `${w}: no agg_time_dimension, and the semantic model declares no defaults.agg_time_dimension — DSI requires one for every measure (metric_time is derived from it)`,
        );
      }
    }
    if (sm.config !== undefined) keys(`${where}.config`, sm.config as Plain, ALLOWED_KEYS.config, out);
  }

  const metricNames = new Set<string>();
  for (const m of (plain.metrics ?? []) as Plain[]) {
    const where = `metrics[${String(m.name)}]`;
    keys(where, m, ALLOWED_KEYS.metric, out);
    name(`${where}.name`, m.name, out);
    if (metricNames.has(String(m.name))) out.push(`${where}: duplicate metric name — metric names are project-global in dbt`);
    metricNames.add(String(m.name));
    if (!isMetricType(m.type)) out.push(`${where}.type: '${String(m.type)}' is not one of simple|ratio|cumulative|derived|conversion`);
    filterOf(where, m, out);
    if (m.config !== undefined) keys(`${where}.config`, m.config as Plain, ALLOWED_KEYS.config, out);
    if (m.time_granularity !== undefined && !isTimeGranularity(m.time_granularity)) out.push(`${where}.time_granularity: '${String(m.time_granularity)}' is not a TimeGranularity`);

    const tp = (m.type_params ?? {}) as Plain;
    keys(`${where}.type_params`, tp, ALLOWED_KEYS.metricTypeParams, out);
    const used: string[] = [];
    if (tp.measure !== undefined) used.push(inputKeys(`${where}.type_params.measure`, tp.measure, ALLOWED_KEYS.metricInputMeasure, out) ?? '');
    if (tp.numerator !== undefined) used.push(inputKeys(`${where}.type_params.numerator`, tp.numerator, ALLOWED_KEYS.metricInput, out) ?? '');
    if (tp.denominator !== undefined) used.push(inputKeys(`${where}.type_params.denominator`, tp.denominator, ALLOWED_KEYS.metricInput, out) ?? '');
    for (const i of (tp.metrics ?? []) as unknown[]) inputKeys(`${where}.type_params.metrics[]`, i, ALLOWED_KEYS.metricInput, out);

    switch (m.type) {
      case 'simple':
        if (tp.measure === undefined) out.push(`${where}: type simple needs type_params.measure`);
        if (measureNames.size && used[0] && !measureNames.has(used[0])) out.push(`${where}: measure '${used[0]}' is not declared in this document`);
        break;
      case 'ratio':
        if (tp.numerator === undefined || tp.denominator === undefined) out.push(`${where}: type ratio needs numerator and denominator`);
        break;
      case 'derived':
        if (!tp.expr) out.push(`${where}: type derived needs type_params.expr`);
        if (tp.expr !== undefined && !isSafeSemanticExpr(String(tp.expr))) {
          out.push(`${where}.type_params.expr: '${String(tp.expr)}' is not in the emitter's closed expr grammar (review M-2)`);
        }
        if (!Array.isArray(tp.metrics) || tp.metrics.length === 0) out.push(`${where}: type derived needs type_params.metrics`);
        break;
      case 'cumulative': {
        if (tp.measure === undefined) out.push(`${where}: type cumulative needs type_params.measure`);
        const c = tp.cumulative_type_params as Plain | undefined;
        if (c) {
          keys(`${where}.type_params.cumulative_type_params`, c, ALLOWED_KEYS.cumulativeTypeParams, out);
          if (c.window !== undefined && c.grain_to_date !== undefined) out.push(`${where}: window and grain_to_date are mutually exclusive`);
          if (c.window !== undefined && !METRIC_TIME_WINDOW_RE.test(String(c.window))) out.push(`${where}: window '${String(c.window)}' is not "<count> <granularity>"`);
          if (c.grain_to_date !== undefined && !isTimeGranularity(c.grain_to_date)) out.push(`${where}: grain_to_date '${String(c.grain_to_date)}' is not a TimeGranularity`);
        }
        break;
      }
      default:
        break;
    }
  }

  // A derived metric's inputs must be metrics of this document (an unknown name fails dbt parse
  // for the whole domain, so it is a violation here rather than a surprise in the pod).
  for (const m of (plain.metrics ?? []) as Plain[]) {
    const tp = (m.type_params ?? {}) as Plain;
    const refs: unknown[] = [...((tp.metrics ?? []) as unknown[])];
    if (m.type === 'ratio') refs.push(tp.numerator, tp.denominator);
    for (const r of refs) {
      if (r === undefined) continue;
      const n = typeof r === 'string' ? r : String((r as Plain).name ?? '');
      if (n && !metricNames.has(n)) out.push(`metrics[${String(m.name)}]: input metric '${n}' is not declared in this document`);
    }
  }
  return out;
}

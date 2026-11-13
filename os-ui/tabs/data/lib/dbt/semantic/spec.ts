/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ONE pinned dbt semantic-layer spec version, its closed enums, and a validator
 * USER STORY: As a data engineer I want to know exactly which dbt semantic spec the OS emits, so
 *             the YAML in my domain repo parses with the dbt my cluster actually runs — and so a
 *             field that does not exist at that version can never reach `dbt parse` (checklist M4).
 * ARCHITECTURE:
 *   - `docs.getdbt.com` serves the dbt 1.12 ("Fusion") spec by default and its `?version=` selector
 *     is client-side only, so the prose does NOT describe what dbt Core 1.8-1.10 accepts. The
 *     authoritative source is the `dbt-semantic-interfaces` (DSI) pydantic spec that dbt-core pins:
 *     dbt 1.8 → DSI 0.5.x · dbt 1.9 → DSI 0.7.x · dbt 1.10 → DSI 0.8.x · dbt 1.12 → none (Rust).
 *   - TARGET is DSI 0.8.5 (= dbt-core 1.10) field names. FLOOR is dbt-core 1.9 / DSI 0.7.x,
 *     because `images/extensions/{dbt,dagster}/Dockerfile` pin `dbt-core>=1.8,<1.10` and therefore
 *     resolve to 1.9.x today. Every field this module permits exists in BOTH 0.7.x and 0.8.5, so
 *     the emitted YAML parses on the shipped image and on the target. The one field that does not
 *     exist on dbt 1.8 — `cumulative_type_params` — is therefore gated on the floor, not the target.
 *   - Pure, dependency-free, no I/O. The enums are CLOSED sets copied from the DSI type_enums, and
 *     the validator is deliberately a key/enum whitelist: anything not named here is a violation,
 *     because an unknown key is exactly how a generator takes a whole domain's `dbt parse` down.
 */

/** The pinned spec. One constant, named in the generated project's README (checklist M4). */
export const DBT_SEMANTIC_SPEC = {
  /** `dbt-semantic-interfaces` version whose field names the emitter targets. */
  dsiVersion: '0.8.5',
  /** The dbt-core release that pins {@link DBT_SEMANTIC_SPEC.dsiVersion}. */
  dbtCore: '1.10',
  /** The lowest dbt-core every emitted field is valid on (what the OS images ship today). */
  minDbtCore: '1.9',
  /** The pip specifier the OS images carry, recorded so a drift is visible in one place. */
  imagePin: 'dbt-core>=1.8,<1.10',
  /** The dbt >= 1.9 model property that declares a time spine (NOT the legacy name). */
  timeSpineProperty: 'time_spine',
  /** The legacy, by-name spine model of dbt <= 1.8 — never emitted; named so nobody adds it back. */
  legacyTimeSpineModel: 'metricflow_time_spine',
} as const;

/** `EntityType` — DSI `type_enums/entity_type.py`. Exactly four. */
export const ENTITY_TYPES = ['primary', 'unique', 'foreign', 'natural'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** `AggregationType` — DSI `type_enums/aggregation_type.py`. Exactly nine. */
export const AGGREGATION_TYPES = [
  'sum',
  'min',
  'max',
  'count_distinct',
  'sum_boolean',
  'average',
  'percentile',
  'median',
  'count',
] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];

/** `TimeGranularity` — DSI `type_enums/time_granularity.py`. */
export const TIME_GRANULARITIES = [
  'nanosecond',
  'microsecond',
  'millisecond',
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type TimeGranularity = (typeof TIME_GRANULARITIES)[number];

/** `MetricType` — DSI `type_enums/metric_type.py`. `conversion` is emitted by nothing yet. */
export const METRIC_TYPES = ['simple', 'ratio', 'cumulative', 'derived', 'conversion'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/** `PeriodAggregation` — DSI `type_enums/period_agg.py`. */
export const PERIOD_AGGREGATIONS = ['first', 'last', 'average'] as const;
export type PeriodAggregation = (typeof PERIOD_AGGREGATIONS)[number];

/** `DimensionType` — DSI `type_enums/dimension_type.py`. */
export const DIMENSION_TYPES = ['categorical', 'time'] as const;
export type DimensionType = (typeof DIMENSION_TYPES)[number];

/** Keys DSI accepts on each object at the pinned version (the whitelist the validator enforces). */
export const ALLOWED_KEYS = {
  semanticModel: ['name', 'description', 'model', 'label', 'primary_entity', 'defaults', 'entities', 'dimensions', 'measures', 'config'],
  defaults: ['agg_time_dimension'],
  entity: ['name', 'type', 'description', 'role', 'expr', 'label', 'config'],
  dimension: ['name', 'type', 'description', 'is_partition', 'type_params', 'expr', 'label', 'config'],
  dimensionTypeParams: ['time_granularity', 'validity_params'],
  measure: ['name', 'agg', 'description', 'create_metric', 'expr', 'agg_params', 'non_additive_dimension', 'agg_time_dimension', 'label', 'config'],
  metric: ['name', 'description', 'type', 'type_params', 'filter', 'label', 'config', 'time_granularity'],
  metricTypeParams: ['measure', 'numerator', 'denominator', 'expr', 'metrics', 'conversion_type_params', 'cumulative_type_params'],
  metricInput: ['name', 'filter', 'alias', 'offset_window', 'offset_to_grain'],
  metricInputMeasure: ['name', 'filter', 'alias', 'join_to_timespine', 'fill_nulls_with'],
  cumulativeTypeParams: ['window', 'grain_to_date', 'period_agg'],
  config: ['meta', 'group', 'enabled', 'tags'],
} as const;

/** `"<count> <granularity>"` — the only form `PydanticMetricTimeWindow` parses. */
export const METRIC_TIME_WINDOW_RE = new RegExp(`^(\\d+)\\s+(${TIME_GRANULARITIES.join('|')})s?$`);

/** A dbt/MetricFlow identifier: the grammar DSI's name validation accepts. */
export const SEMANTIC_NAME_RE = /^[a-z_][a-z0-9_]*$/;

export function isEntityType(v: unknown): v is EntityType {
  return typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);
}
export function isAggregationType(v: unknown): v is AggregationType {
  return typeof v === 'string' && (AGGREGATION_TYPES as readonly string[]).includes(v);
}
export function isTimeGranularity(v: unknown): v is TimeGranularity {
  return typeof v === 'string' && (TIME_GRANULARITIES as readonly string[]).includes(v);
}
export function isMetricType(v: unknown): v is MetricType {
  return typeof v === 'string' && (METRIC_TYPES as readonly string[]).includes(v);
}
export function isDimensionType(v: unknown): v is DimensionType {
  return typeof v === 'string' && (DIMENSION_TYPES as readonly string[]).includes(v);
}

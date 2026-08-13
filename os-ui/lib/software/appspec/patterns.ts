/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The tab-pattern COOKBOOK (Track 2, Phase 3.5a).
 *
 * A pattern is a NAMED, config-only recipe for a tab body — the author fills a small closed
 * `config` and the OS renderer produces a polished, governed surface. This is the whole point
 * of the declarative model: no raw code, no prop-name drift, no cross-origin data auth to get
 * wrong. The registry below is the single source of truth for:
 *   • the closed `PatternId` enum (the grammar — ALL ids are valid so specs referencing a
 *     not-yet-implemented pattern parse cleanly and render an honest "coming soon" placeholder),
 *   • each pattern's `category` (a `view` reads data; an `interactive` pattern WRITES through the
 *     governed `os.records` door / a role gate — never arbitrary code),
 *   • each pattern's structural `parseConfig` (validates the config slots into a typed shape),
 *   • each pattern's `summarize(config)` — a plain-language "what this shows / does" line that
 *     feeds the legibility surface (`describeApp` → the future "How this app works" panel).
 *
 * Only the FOUR flagship patterns have renderers this phase (`records-table`, `detail`,
 * `status-board`, `intake-wizard`); the rest are valid, categorized ids with a real config
 * parser where useful, rendered as an honest placeholder until their phase implements them.
 *
 * NO Zod (repo has none): the config parsers reuse the SAME hand-written `{path,reason,fix}`
 * issue machinery as `schema.ts`, imported from there (schema imports the REGISTRY back only
 * inside its runtime tab parser, so the cycle is deferred and safe).
 */

import {
  bad,
  isObject,
  optString,
  parseColumnLike,
  parseDatasetSource,
  reqArray,
  reqEnum,
  reqString,
  type Ctx,
  type DetailField,
  type FieldType,
  type FormField,
  type TableColumn,
  type TableFilter,
  FIELD_TYPES,
  CONTROLS,
} from './schema.ts';

// --------------------------------------------------------------------- pattern ids ----

/**
 * The closed set of pattern ids. Categorised below. `view` patterns read; `interactive`
 * patterns write (through the governed `os.records` door and role gates — still a safe box).
 * Every id is a VALID grammar token even before its renderer exists.
 */
export const PATTERN_IDS = [
  // — VIEW —
  'records-table',
  'master-detail',
  'detail',
  'status-board',
  'kpi-overview',
  'chart-explorer',
  'card-gallery',
  'timeline',
  'calendar',
  'landing',
  // — INTERACTIVE (write via os.records / role gates) —
  'form',
  'intake-wizard',
  // reserved interactive ids (valid + categorised now; implemented in a later phase)
  'editable-grid',
  'kanban-workflow',
  'approval-queue',
  'assignment',
  'task-checklist',
  'action-detail',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export type PatternCategory = 'view' | 'interactive';

/**
 * The patterns with real renderers: the 4 flagship (3.5a) + the 7 VIEW patterns (3.5b) + the 4
 * INTERACTIVE append patterns (3.5c: `form`, `assignment`, `approval-queue`, `task-checklist`).
 */
export const IMPLEMENTED_PATTERNS = [
  'records-table',
  'detail',
  'status-board',
  'intake-wizard',
  'master-detail',
  'kpi-overview',
  'chart-explorer',
  'card-gallery',
  'timeline',
  'calendar',
  'landing',
  'form',
  'assignment',
  'approval-queue',
  'task-checklist',
] as const satisfies readonly PatternId[];
export type ImplementedPatternId = (typeof IMPLEMENTED_PATTERNS)[number];

const IMPLEMENTED_SET = new Set<PatternId>(IMPLEMENTED_PATTERNS);
export function isImplementedPattern(id: PatternId): id is ImplementedPatternId {
  return IMPLEMENTED_SET.has(id);
}

// ----------------------------------------------------------------- per-pattern config --

/** `records-table` — a searchable, filterable, sortable, paged table over a dataset. */
export type RecordsTableConfig = {
  source: { datasetId: string };
  columns: TableColumn[];
  filters?: TableFilter[];
  search?: boolean;
  sort?: string;
  pageSize?: number;
};

/** `detail` — pick one record by `keyField`, show its `fields` as label/value pairs. */
export type DetailConfig = {
  source: { datasetId: string };
  keyField: string;
  fields: DetailField[];
};

/** One step of an intake wizard: a titled group of fields collected together. */
export type WizardStep = { title: string; fields: FormField[] };

/** `intake-wizard` — a multi-step click-through that writes one record via `os.records.add`. */
export type IntakeWizardConfig = {
  target: 'records';
  steps: WizardStep[];
  submitLabel: string;
};

/** `status-board` — records grouped into columns by `statusField`, rendered as tiles. */
export type StatusBoardConfig = {
  source: { datasetId: string };
  statusField: string;
  columns?: { value: string; label: string }[];
  titleField: string;
  subtitleFields?: string[];
};

// — 3.5b VIEW patterns —

/** `master-detail` — a list/table on the left, the selected record's detail on the right. */
export type MasterDetailConfig = {
  source: { datasetId: string };
  keyField: string;
  listColumns: TableColumn[];
  detailFields: DetailField[];
};

/** How a KPI card sources its number: a governed metric, an aggregate over a dataset, or the
 *  evaluated value of a governed backend DSL `function` (3.5d — aggregate or expression). */
export type KpiAgg = 'count' | 'sum' | 'avg';
export type KpiCard = {
  label: string;
  metric?: { metricId: string };
  dataset?: { datasetId: string; agg: KpiAgg; field?: string };
  function?: { functionId: string };
};

/** `kpi-overview` — a responsive grid of headline number cards. */
export type KpiOverviewConfig = { cards: KpiCard[] };

/** `chart-explorer` — a governed metric charted via ECharts with dimension/grain controls. */
export type ChartKind = 'line' | 'bar' | 'area';
export type ChartExplorerConfig = {
  metric: { metricId: string };
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  chart: ChartKind;
};

/** `card-gallery` — records as a responsive card grid with optional search. */
export type CardGalleryConfig = {
  source: { datasetId: string };
  titleField: string;
  subtitleField?: string;
  fields?: TableColumn[];
  search?: boolean;
};

/** `timeline` — records on a vertical time axis, newest first. */
export type TimelineConfig = {
  source: { datasetId: string };
  dateField: string;
  titleField: string;
  descriptionField?: string;
};

/** `calendar` — records placed on a month grid by their date. */
export type CalendarConfig = {
  source: { datasetId: string };
  dateField: string;
  titleField: string;
};

/** One block of a `landing` composed home page. */
export type LandingBlock =
  | { kind: 'markdown'; content: string }
  | { kind: 'kpi'; cards: KpiCard[] }
  | { kind: 'table'; source: { datasetId: string }; columns: TableColumn[] };

/** `landing` — a composed home page: prose + KPIs + a featured table. */
export type LandingConfig = { blocks: LandingBlock[] };

// — 3.5c INTERACTIVE patterns (append-only governed `os.records.add`) —

/**
 * `form` — a single-screen create: collect `fields`, write ONE record via `os.records.add`. The
 * one-step sibling of `intake-wizard`; `target:'records'` names the app's own record store.
 */
export type FormConfig = {
  target: 'records';
  fields: FormField[];
  submitLabel?: string;
};

/**
 * `assignment` — pick an ITEM from `source` and an ASSIGNEE from `assignTo` (both granted
 * datasets), plus any `extraFields`, and APPEND an assignment record
 * `{ itemId, assigneeId, ...extra, at }` via `os.records.add`. No in-place mutation — the
 * assignment is a new governed record in the app's own log.
 */
export type AssignmentConfig = {
  source: { datasetId: string };
  itemLabelField: string;
  assignTo: { datasetId: string; optionLabelField: string };
  extraFields?: FormField[];
};

/**
 * `approval-queue` — list pending items (from the app's own `records` OR a granted dataset), and
 * per item APPEND a decision record `{ itemId, decision, reason, by, at }` via `os.records.add`.
 * The item's CURRENT decision (if any) is DERIVED by reducing the append log (latest wins).
 * `decisionField` names the record field carrying the choice (default 'decision'); when
 * `reasonRequired` a reject (and approve) must carry a reason.
 */
export type ApprovalQueueConfig = {
  source: 'records' | { datasetId: string };
  titleField: string;
  subtitleFields?: string[];
  decisionField?: string;
  reasonRequired?: boolean;
};

/**
 * `task-checklist` — a checklist over the app's own `records` OR a granted dataset. Checking an
 * item APPENDS a completion record `{ taskId, done:true, by, at }` via `os.records.add`; the
 * done-state is DERIVED by reducing the append log (latest per task wins, so it toggles).
 */
export type TaskChecklistConfig = {
  source: 'records' | { datasetId: string };
  titleField: string;
  assigneeField?: string;
};

/**
 * The config union. Not-yet-implemented patterns carry an OPAQUE config: it parsed
 * structurally as a plain object (no slots enforced yet — their phase adds the parser), so a
 * spec can reference them without error and the placeholder renders honestly.
 */
export type OpaqueConfig = { readonly [k: string]: unknown };

export type PatternConfig =
  | RecordsTableConfig
  | DetailConfig
  | IntakeWizardConfig
  | StatusBoardConfig
  | MasterDetailConfig
  | KpiOverviewConfig
  | ChartExplorerConfig
  | CardGalleryConfig
  | TimelineConfig
  | CalendarConfig
  | LandingConfig
  | FormConfig
  | AssignmentConfig
  | ApprovalQueueConfig
  | TaskChecklistConfig
  | OpaqueConfig;

// ---------------------------------------------------------------- config sub-parsers ----

function parseFilters(ctx: Ctx, raw: unknown, path: string): TableFilter[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    bad(ctx, path, 'filters must be an array', 'remove filters or set a list');
    return undefined;
  }
  const out: TableFilter[] = [];
  raw.forEach((f, i) => {
    const fp = `${path}[${i}]`;
    if (!isObject(f)) {
      bad(ctx, fp, 'filter must be an object', 'use { field, control }');
      return;
    }
    const field = reqString(ctx, f, 'field', `${fp}.field`);
    const control = reqEnum(ctx, f, 'control', CONTROLS, `${fp}.control`);
    if (field !== undefined && control !== undefined) out.push({ field, control });
  });
  return out;
}

function parseColumns(ctx: Ctx, raw: unknown[], path: string): TableColumn[] {
  const out: TableColumn[] = [];
  raw.forEach((c, i) => {
    const col = parseColumnLike(ctx, c, `${path}[${i}]`);
    if (col) out.push(col);
  });
  return out;
}

function optPositiveInt(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    bad(ctx, path, `${key} must be a positive integer`, `set ${key} to a positive whole number`);
    return undefined;
  }
  return v;
}

function optBool(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    bad(ctx, path, `${key} must be a boolean`, `set ${key} to true/false or remove it`);
    return undefined;
  }
  return v;
}

function optStringArray(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    bad(ctx, path, `${key} must be an array of strings`, `remove ${key} or set a list of field names`);
    return undefined;
  }
  const out: string[] = [];
  v.forEach((s, i) => {
    if (typeof s !== 'string' || s.trim() === '') bad(ctx, `${path}[${i}]`, 'must be a non-empty string', 'use a field name');
    else out.push(s);
  });
  return out;
}

function parseRecordsTableConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): RecordsTableConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const columnsRaw = reqArray(ctx, obj, 'columns', `${path}.columns`);
  const columns = columnsRaw ? parseColumns(ctx, columnsRaw, `${path}.columns`) : [];
  const filters = parseFilters(ctx, obj.filters, `${path}.filters`);
  const search = optBool(ctx, obj, 'search', `${path}.search`);
  const sort = optString(ctx, obj, 'sort', `${path}.sort`);
  const pageSize = optPositiveInt(ctx, obj, 'pageSize', `${path}.pageSize`);
  if (datasetId === undefined || !columnsRaw) return undefined;
  return {
    source: { datasetId },
    columns,
    ...(obj.filters !== undefined ? { filters: filters ?? [] } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  };
}

function parseDetailConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): DetailConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const keyField = reqString(ctx, obj, 'keyField', `${path}.keyField`);
  const fieldsRaw = reqArray(ctx, obj, 'fields', `${path}.fields`);
  const fields: DetailField[] = fieldsRaw ? parseColumns(ctx, fieldsRaw, `${path}.fields`) : [];
  if (datasetId === undefined || keyField === undefined || !fieldsRaw) return undefined;
  return { source: { datasetId }, keyField, fields };
}

function parseFormField(ctx: Ctx, raw: unknown, path: string): FormField | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'field must be an object', 'use { name, label, type, required? }');
    return undefined;
  }
  const name = reqString(ctx, raw, 'name', `${path}.name`);
  const label = reqString(ctx, raw, 'label', `${path}.label`);
  const type = reqEnum<FieldType>(ctx, raw, 'type', FIELD_TYPES, `${path}.type`);
  const required = optBool(ctx, raw, 'required', `${path}.required`);
  if (name === undefined || label === undefined || type === undefined) return undefined;
  return { name, label, type, ...(required !== undefined ? { required } : {}) };
}

function parseIntakeWizardConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): IntakeWizardConfig | undefined {
  const target = reqEnum(ctx, obj, 'target', ['records'] as const, `${path}.target`);
  const stepsRaw = reqArray(ctx, obj, 'steps', `${path}.steps`);
  const steps: WizardStep[] = [];
  if (stepsRaw) {
    stepsRaw.forEach((s, i) => {
      const sp = `${path}.steps[${i}]`;
      if (!isObject(s)) {
        bad(ctx, sp, 'step must be an object', 'use { title, fields }');
        return;
      }
      const title = reqString(ctx, s, 'title', `${sp}.title`);
      const fieldsRaw = reqArray(ctx, s, 'fields', `${sp}.fields`);
      const fields: FormField[] = [];
      if (fieldsRaw) {
        fieldsRaw.forEach((f, j) => {
          const ff = parseFormField(ctx, f, `${sp}.fields[${j}]`);
          if (ff) fields.push(ff);
        });
      }
      if (title !== undefined && fieldsRaw) steps.push({ title, fields });
    });
  }
  const submitLabel = reqString(ctx, obj, 'submitLabel', `${path}.submitLabel`);
  if (target === undefined || !stepsRaw || submitLabel === undefined) return undefined;
  return { target, steps, submitLabel };
}

function parseStatusBoardConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): StatusBoardConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const statusField = reqString(ctx, obj, 'statusField', `${path}.statusField`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  const subtitleFields = optStringArray(ctx, obj, 'subtitleFields', `${path}.subtitleFields`);

  let columns: { value: string; label: string }[] | undefined;
  if (obj.columns !== undefined) {
    if (!Array.isArray(obj.columns)) {
      bad(ctx, `${path}.columns`, 'columns must be an array', 'use [{ value, label }] or remove columns');
    } else {
      columns = [];
      obj.columns.forEach((c, i) => {
        const cp = `${path}.columns[${i}]`;
        if (!isObject(c)) {
          bad(ctx, cp, 'column must be an object', 'use { value, label }');
          return;
        }
        const value = reqString(ctx, c, 'value', `${cp}.value`);
        const label = reqString(ctx, c, 'label', `${cp}.label`);
        if (value !== undefined && label !== undefined) columns!.push({ value, label });
      });
    }
  }

  if (datasetId === undefined || statusField === undefined || titleField === undefined) return undefined;
  return {
    source: { datasetId },
    statusField,
    titleField,
    ...(columns !== undefined ? { columns } : {}),
    ...(subtitleFields !== undefined ? { subtitleFields } : {}),
  };
}

/** Parse a metric source `{ metricId }` object; returns the id or undefined (typed issue). */
function parseMetricSource(ctx: Ctx, raw: unknown, path: string): string | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'metric must be an object', 'use { metricId }');
    return undefined;
  }
  return reqString(ctx, raw, 'metricId', `${path}.metricId`);
}

/** Parse a required, non-empty array of `{ field, label?, format? }` columns. */
function parseColumnArray(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): TableColumn[] | undefined {
  const raw = reqArray(ctx, obj, key, `${path}.${key}`);
  if (!raw) return undefined;
  return parseColumns(ctx, raw, `${path}.${key}`);
}

const KPI_AGGS = ['count', 'sum', 'avg'] as const;

/** Parse ONE KPI card: `{ label, metric?, dataset? }` — exactly one source (metric OR dataset). */
function parseKpiCard(ctx: Ctx, raw: unknown, path: string): KpiCard | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'card must be an object', 'use { label, metric? | dataset? }');
    return undefined;
  }
  const label = reqString(ctx, raw, 'label', `${path}.label`);

  let metric: { metricId: string } | undefined;
  if (raw.metric !== undefined) {
    const metricId = parseMetricSource(ctx, raw.metric, `${path}.metric`);
    if (metricId !== undefined) metric = { metricId };
  }

  let dataset: { datasetId: string; agg: KpiAgg; field?: string } | undefined;
  if (raw.dataset !== undefined) {
    if (!isObject(raw.dataset)) {
      bad(ctx, `${path}.dataset`, 'dataset must be an object', 'use { datasetId, agg, field? }');
    } else {
      const datasetId = reqString(ctx, raw.dataset, 'datasetId', `${path}.dataset.datasetId`);
      const agg = reqEnum<KpiAgg>(ctx, raw.dataset, 'agg', KPI_AGGS, `${path}.dataset.agg`);
      const field = optString(ctx, raw.dataset, 'field', `${path}.dataset.field`);
      // sum/avg NEED a field; count does not.
      if (agg !== undefined && agg !== 'count' && field === undefined) {
        bad(ctx, `${path}.dataset.field`, `field is required for agg "${agg}"`, 'name the numeric field to aggregate');
      }
      if (datasetId !== undefined && agg !== undefined && (agg === 'count' || field !== undefined)) {
        dataset = { datasetId, agg, ...(field !== undefined ? { field } : {}) };
      }
    }
  }

  // 3.5d: a card may instead render a governed backend DSL function's evaluated value.
  let fn: { functionId: string } | undefined;
  if (raw.function !== undefined) {
    if (!isObject(raw.function)) {
      bad(ctx, `${path}.function`, 'function must be an object', 'use { functionId }');
    } else {
      const functionId = reqString(ctx, raw.function, 'functionId', `${path}.function.functionId`);
      if (functionId !== undefined) fn = { functionId };
    }
  }

  // EXACTLY ONE source of the three (metric | dataset | function).
  const sources = [metric, dataset, fn].filter((s) => s !== undefined).length;
  if (sources !== 1) {
    bad(ctx, path, 'a card needs exactly one source', 'set exactly one of metric:{metricId}, dataset:{datasetId, agg, field?}, or function:{functionId}');
    return undefined;
  }
  if (label === undefined) return undefined;
  return {
    label,
    ...(metric !== undefined ? { metric } : {}),
    ...(dataset !== undefined ? { dataset } : {}),
    ...(fn !== undefined ? { function: fn } : {}),
  };
}

/** Parse a required, non-empty array of KPI cards. */
function parseKpiCards(ctx: Ctx, obj: Record<string, unknown>, path: string): KpiCard[] | undefined {
  const raw = reqArray(ctx, obj, 'cards', `${path}.cards`);
  if (!raw) return undefined;
  const out: KpiCard[] = [];
  raw.forEach((c, i) => {
    const card = parseKpiCard(ctx, c, `${path}.cards[${i}]`);
    if (card) out.push(card);
  });
  return out;
}

function parseMasterDetailConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): MasterDetailConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const keyField = reqString(ctx, obj, 'keyField', `${path}.keyField`);
  const listColumns = parseColumnArray(ctx, obj, 'listColumns', path);
  const detailFields = parseColumnArray(ctx, obj, 'detailFields', path);
  if (datasetId === undefined || keyField === undefined || !listColumns || !detailFields) return undefined;
  return { source: { datasetId }, keyField, listColumns, detailFields };
}

function parseKpiOverviewConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): KpiOverviewConfig | undefined {
  const cards = parseKpiCards(ctx, obj, path);
  if (!cards) return undefined;
  return { cards };
}

const CHART_KINDS = ['line', 'bar', 'area'] as const;

function parseChartExplorerConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): ChartExplorerConfig | undefined {
  const metricId = parseMetricSource(ctx, obj.metric, `${path}.metric`);
  const chart = reqEnum<ChartKind>(ctx, obj, 'chart', CHART_KINDS, `${path}.chart`);
  const dimensions = optStringArray(ctx, obj, 'dimensions', `${path}.dimensions`);
  const timeDimension = optString(ctx, obj, 'timeDimension', `${path}.timeDimension`);
  const granularity = optString(ctx, obj, 'granularity', `${path}.granularity`);
  if (metricId === undefined || chart === undefined) return undefined;
  return {
    metric: { metricId },
    chart,
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(timeDimension !== undefined ? { timeDimension } : {}),
    ...(granularity !== undefined ? { granularity } : {}),
  };
}

function parseCardGalleryConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): CardGalleryConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  const subtitleField = optString(ctx, obj, 'subtitleField', `${path}.subtitleField`);
  const search = optBool(ctx, obj, 'search', `${path}.search`);
  let fields: TableColumn[] | undefined;
  if (obj.fields !== undefined) {
    if (!Array.isArray(obj.fields)) {
      bad(ctx, `${path}.fields`, 'fields must be an array', 'use [{ field, label?, format? }] or remove fields');
    } else {
      fields = parseColumns(ctx, obj.fields, `${path}.fields`);
    }
  }
  if (datasetId === undefined || titleField === undefined) return undefined;
  return {
    source: { datasetId },
    titleField,
    ...(subtitleField !== undefined ? { subtitleField } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(search !== undefined ? { search } : {}),
  };
}

function parseTimelineConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): TimelineConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const dateField = reqString(ctx, obj, 'dateField', `${path}.dateField`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  const descriptionField = optString(ctx, obj, 'descriptionField', `${path}.descriptionField`);
  if (datasetId === undefined || dateField === undefined || titleField === undefined) return undefined;
  return {
    source: { datasetId },
    dateField,
    titleField,
    ...(descriptionField !== undefined ? { descriptionField } : {}),
  };
}

function parseCalendarConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): CalendarConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const dateField = reqString(ctx, obj, 'dateField', `${path}.dateField`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  if (datasetId === undefined || dateField === undefined || titleField === undefined) return undefined;
  return { source: { datasetId }, dateField, titleField };
}

const LANDING_BLOCK_KINDS = ['markdown', 'kpi', 'table'] as const;

function parseLandingBlock(ctx: Ctx, raw: unknown, path: string): LandingBlock | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'block must be an object', 'use { kind: "markdown" | "kpi" | "table", … }');
    return undefined;
  }
  const kind = reqEnum(ctx, raw, 'kind', LANDING_BLOCK_KINDS, `${path}.kind`);
  switch (kind) {
    case 'markdown': {
      const content = reqString(ctx, raw, 'content', `${path}.content`);
      return content !== undefined ? { kind: 'markdown', content } : undefined;
    }
    case 'kpi': {
      const cards = parseKpiCards(ctx, raw, path);
      return cards ? { kind: 'kpi', cards } : undefined;
    }
    case 'table': {
      const datasetId = parseDatasetSource(ctx, raw.source, `${path}.source`);
      const columns = parseColumnArray(ctx, raw, 'columns', path);
      if (datasetId === undefined || !columns) return undefined;
      return { kind: 'table', source: { datasetId }, columns };
    }
    default:
      return undefined; // kind already reported
  }
}

function parseLandingConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): LandingConfig | undefined {
  const raw = reqArray(ctx, obj, 'blocks', `${path}.blocks`);
  if (!raw) return undefined;
  const blocks: LandingBlock[] = [];
  raw.forEach((b, i) => {
    const block = parseLandingBlock(ctx, b, `${path}.blocks[${i}]`);
    if (block) blocks.push(block);
  });
  // If every block failed to parse, that's a structural failure (issues already pushed).
  if (blocks.length === 0) return undefined;
  return { blocks };
}

// — 3.5c INTERACTIVE parsers —

/** Parse a required, non-empty array of FormFields `{ name, label, type, required? }`. */
function parseFormFields(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): FormField[] | undefined {
  const raw = reqArray(ctx, obj, key, `${path}.${key}`);
  if (!raw) return undefined;
  const out: FormField[] = [];
  raw.forEach((f, i) => {
    const ff = parseFormField(ctx, f, `${path}.${key}[${i}]`);
    if (ff) out.push(ff);
  });
  return out;
}

/** Parse an OPTIONAL FormField array (used for `assignment.extraFields`). */
function parseOptFormFields(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): FormField[] | undefined {
  if (obj[key] === undefined) return undefined;
  if (!Array.isArray(obj[key])) {
    bad(ctx, `${path}.${key}`, `${key} must be an array`, `remove ${key} or set a list of { name, label, type }`);
    return undefined;
  }
  const out: FormField[] = [];
  (obj[key] as unknown[]).forEach((f, i) => {
    const ff = parseFormField(ctx, f, `${path}.${key}[${i}]`);
    if (ff) out.push(ff);
  });
  return out;
}

/**
 * Parse an INTERACTIVE `source`: the literal string `'records'` (the app's own record log) OR a
 * `{ datasetId }` object (a granted dataset the queue/checklist reads from). Returns the parsed
 * source or undefined (with a typed issue).
 */
function parseRecordsOrDatasetSource(ctx: Ctx, raw: unknown, path: string): 'records' | { datasetId: string } | undefined {
  if (raw === 'records') return 'records';
  if (isObject(raw)) {
    const datasetId = reqString(ctx, raw, 'datasetId', `${path}.datasetId`);
    return datasetId !== undefined ? { datasetId } : undefined;
  }
  bad(ctx, path, 'source must be "records" or { datasetId }', 'use "records" for the app\'s own log, or { datasetId } for a granted dataset');
  return undefined;
}

function parseFormConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): FormConfig | undefined {
  const target = reqEnum(ctx, obj, 'target', ['records'] as const, `${path}.target`);
  const fields = parseFormFields(ctx, obj, 'fields', path);
  const submitLabel = optString(ctx, obj, 'submitLabel', `${path}.submitLabel`);
  if (target === undefined || !fields) return undefined;
  return { target, fields, ...(submitLabel !== undefined ? { submitLabel } : {}) };
}

function parseAssignmentConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): AssignmentConfig | undefined {
  const datasetId = parseDatasetSource(ctx, obj.source, `${path}.source`);
  const itemLabelField = reqString(ctx, obj, 'itemLabelField', `${path}.itemLabelField`);

  let assignTo: { datasetId: string; optionLabelField: string } | undefined;
  if (!isObject(obj.assignTo)) {
    bad(ctx, `${path}.assignTo`, 'assignTo must be an object', 'use { datasetId, optionLabelField }');
  } else {
    const atDataset = reqString(ctx, obj.assignTo, 'datasetId', `${path}.assignTo.datasetId`);
    const optionLabelField = reqString(ctx, obj.assignTo, 'optionLabelField', `${path}.assignTo.optionLabelField`);
    if (atDataset !== undefined && optionLabelField !== undefined) assignTo = { datasetId: atDataset, optionLabelField };
  }

  const extraFields = parseOptFormFields(ctx, obj, 'extraFields', path);
  if (datasetId === undefined || itemLabelField === undefined || !assignTo) return undefined;
  return {
    source: { datasetId },
    itemLabelField,
    assignTo,
    ...(extraFields !== undefined ? { extraFields } : {}),
  };
}

function parseApprovalQueueConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): ApprovalQueueConfig | undefined {
  const source = parseRecordsOrDatasetSource(ctx, obj.source, `${path}.source`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  const subtitleFields = optStringArray(ctx, obj, 'subtitleFields', `${path}.subtitleFields`);
  const decisionField = optString(ctx, obj, 'decisionField', `${path}.decisionField`);
  const reasonRequired = optBool(ctx, obj, 'reasonRequired', `${path}.reasonRequired`);
  if (source === undefined || titleField === undefined) return undefined;
  return {
    source,
    titleField,
    ...(subtitleFields !== undefined ? { subtitleFields } : {}),
    ...(decisionField !== undefined ? { decisionField } : {}),
    ...(reasonRequired !== undefined ? { reasonRequired } : {}),
  };
}

function parseTaskChecklistConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): TaskChecklistConfig | undefined {
  const source = parseRecordsOrDatasetSource(ctx, obj.source, `${path}.source`);
  const titleField = reqString(ctx, obj, 'titleField', `${path}.titleField`);
  const assigneeField = optString(ctx, obj, 'assigneeField', `${path}.assigneeField`);
  if (source === undefined || titleField === undefined) return undefined;
  return { source, titleField, ...(assigneeField !== undefined ? { assigneeField } : {}) };
}

/**
 * The placeholder config parser for a not-yet-implemented pattern: accept ANY object (its
 * phase adds the real slot validation). This keeps a spec referencing a coming-soon pattern
 * structurally VALID without pretending we validated slots we don't render yet.
 */
function parseOpaqueConfig(ctx: Ctx, obj: Record<string, unknown>, path: string): OpaqueConfig | undefined {
  // obj is already confirmed an object by the caller; nothing more to enforce here yet.
  void ctx;
  void path;
  return obj as OpaqueConfig;
}

// -------------------------------------------------------------------- summarizers ----

function fieldList(fields: { field?: string; name?: string }[]): string {
  return fields.map((f) => f.field ?? f.name ?? '?').join(', ');
}

// --------------------------------------------------------------------- the registry ----

export type PatternDef = {
  id: PatternId;
  label: string;
  category: PatternCategory;
  description: string;
  implemented: boolean;
  /** Structural parser for this pattern's config — returns the typed config or undefined. */
  parseConfig: (ctx: Ctx, obj: Record<string, unknown>, path: string) => PatternConfig | undefined;
  /** Plain-language "what this shows / does" for the legibility surface. */
  summarize: (config: PatternConfig) => string;
};

/** Build a reserved/coming-soon entry (valid id, opaque config, honest summary). */
function comingSoon(
  id: PatternId,
  label: string,
  category: PatternCategory,
  description: string,
): PatternDef {
  return {
    id,
    label,
    category,
    description,
    implemented: false,
    parseConfig: parseOpaqueConfig,
    summarize: () => `${label} (${category === 'view' ? 'view' : 'action'}) — coming soon.`,
  };
}

export const PATTERNS: Record<PatternId, PatternDef> = {
  // ---- implemented flagship (view) ----
  'records-table': {
    id: 'records-table',
    label: 'Records table',
    category: 'view',
    description: 'A searchable, filterable, sortable, paged table over a dataset.',
    implemented: true,
    parseConfig: parseRecordsTableConfig,
    summarize: (c) => {
      const cfg = c as RecordsTableConfig;
      return `Shows records from ${cfg.source.datasetId} as a table of ${fieldList(cfg.columns)}${cfg.search ? ', with search' : ''}.`;
    },
  },
  detail: {
    id: 'detail',
    label: 'Record detail',
    category: 'view',
    description: 'Pick one record and read its fields as a label/value sheet.',
    implemented: true,
    parseConfig: parseDetailConfig,
    summarize: (c) => {
      const cfg = c as DetailConfig;
      return `Shows one record from ${cfg.source.datasetId} (chosen by ${cfg.keyField}) with its ${cfg.fields.length} field${cfg.fields.length === 1 ? '' : 's'}.`;
    },
  },
  'status-board': {
    id: 'status-board',
    label: 'Status board',
    category: 'view',
    description: 'Records grouped into columns by a status field, shown as tiles.',
    implemented: true,
    parseConfig: parseStatusBoardConfig,
    summarize: (c) => {
      const cfg = c as StatusBoardConfig;
      return `Groups records from ${cfg.source.datasetId} into columns by ${cfg.statusField}, each a tile titled by ${cfg.titleField}.`;
    },
  },

  // ---- implemented flagship (interactive) ----
  'intake-wizard': {
    id: 'intake-wizard',
    label: 'Intake wizard',
    category: 'interactive',
    description: 'A multi-step form that collects fields and writes one governed record.',
    implemented: true,
    parseConfig: parseIntakeWizardConfig,
    summarize: (c) => {
      const cfg = c as IntakeWizardConfig;
      const nFields = cfg.steps.reduce((n, s) => n + s.fields.length, 0);
      return `Collects ${nFields} field${nFields === 1 ? '' : 's'} across ${cfg.steps.length} step${cfg.steps.length === 1 ? '' : 's'} and saves a new record (governed).`;
    },
  },

  // ---- view patterns (3.5b) ----
  'master-detail': {
    id: 'master-detail',
    label: 'Master / detail',
    category: 'view',
    description: 'A list on the left, the selected record’s detail on the right.',
    implemented: true,
    parseConfig: parseMasterDetailConfig,
    summarize: (c) => {
      const cfg = c as MasterDetailConfig;
      return `Lists records from ${cfg.source.datasetId} (by ${cfg.keyField}); selecting one shows its ${cfg.detailFields.length} field${cfg.detailFields.length === 1 ? '' : 's'} beside the list.`;
    },
  },
  'kpi-overview': {
    id: 'kpi-overview',
    label: 'KPI overview',
    category: 'view',
    description: 'A grid of headline metric cards.',
    implemented: true,
    parseConfig: parseKpiOverviewConfig,
    summarize: (c) => {
      const cfg = c as KpiOverviewConfig;
      return `Shows ${cfg.cards.length} headline number${cfg.cards.length === 1 ? '' : 's'}: ${cfg.cards.map((k) => k.label).join(', ')}.`;
    },
  },
  'chart-explorer': {
    id: 'chart-explorer',
    label: 'Chart explorer',
    category: 'view',
    description: 'A governed metric charted by dimension and time.',
    implemented: true,
    parseConfig: parseChartExplorerConfig,
    summarize: (c) => {
      const cfg = c as ChartExplorerConfig;
      const by = cfg.timeDimension ? ` over ${cfg.timeDimension}` : cfg.dimensions && cfg.dimensions.length > 0 ? ` by ${cfg.dimensions.join(', ')}` : '';
      return `Charts the metric ${cfg.metric.metricId} as a ${cfg.chart} chart${by}.`;
    },
  },
  'card-gallery': {
    id: 'card-gallery',
    label: 'Card gallery',
    category: 'view',
    description: 'Records as a responsive gallery of cards.',
    implemented: true,
    parseConfig: parseCardGalleryConfig,
    summarize: (c) => {
      const cfg = c as CardGalleryConfig;
      return `Shows records from ${cfg.source.datasetId} as a gallery of cards titled by ${cfg.titleField}${cfg.search ? ', with search' : ''}.`;
    },
  },
  timeline: {
    id: 'timeline',
    label: 'Timeline',
    category: 'view',
    description: 'Records ordered along a time axis, newest first.',
    implemented: true,
    parseConfig: parseTimelineConfig,
    summarize: (c) => {
      const cfg = c as TimelineConfig;
      return `Places records from ${cfg.source.datasetId} on a timeline by ${cfg.dateField} (newest first), titled by ${cfg.titleField}.`;
    },
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    category: 'view',
    description: 'Records placed on a month calendar by their date.',
    implemented: true,
    parseConfig: parseCalendarConfig,
    summarize: (c) => {
      const cfg = c as CalendarConfig;
      return `Places records from ${cfg.source.datasetId} on a month calendar by ${cfg.dateField}, labelled by ${cfg.titleField}.`;
    },
  },
  landing: {
    id: 'landing',
    label: 'Landing',
    category: 'view',
    description: 'A composed home page of prose, KPIs and a featured table.',
    implemented: true,
    parseConfig: parseLandingConfig,
    summarize: (c) => {
      const cfg = c as LandingConfig;
      const kinds = cfg.blocks.map((b) => b.kind);
      return `A home page composed of ${cfg.blocks.length} block${cfg.blocks.length === 1 ? '' : 's'} (${kinds.join(', ')}).`;
    },
  },

  // ---- interactive APPEND patterns (3.5c) — write via governed os.records.add ----
  form: {
    id: 'form',
    label: 'Form',
    category: 'interactive',
    description: 'A single-screen form that writes one governed record.',
    implemented: true,
    parseConfig: parseFormConfig,
    summarize: (c) => {
      const cfg = c as FormConfig;
      return `Collects ${cfg.fields.length} field${cfg.fields.length === 1 ? '' : 's'} on one screen and saves a new record (governed).`;
    },
  },
  assignment: {
    id: 'assignment',
    label: 'Assignment',
    category: 'interactive',
    description: 'Pick an item and an assignee, then append a governed assignment record.',
    implemented: true,
    parseConfig: parseAssignmentConfig,
    summarize: (c) => {
      const cfg = c as AssignmentConfig;
      return `Assigns an item from ${cfg.source.datasetId} to someone from ${cfg.assignTo.datasetId}, saving a new assignment record (governed).`;
    },
  },
  'approval-queue': {
    id: 'approval-queue',
    label: 'Approval queue',
    category: 'interactive',
    description: 'List pending items and approve or reject each, appending a governed decision.',
    implemented: true,
    parseConfig: parseApprovalQueueConfig,
    summarize: (c) => {
      const cfg = c as ApprovalQueueConfig;
      const from = cfg.source === 'records' ? 'the app’s own records' : cfg.source.datasetId;
      return `Lists items from ${from} to approve or reject (each decision saved as a governed record).`;
    },
  },
  'task-checklist': {
    id: 'task-checklist',
    label: 'Task checklist',
    category: 'interactive',
    description: 'A checklist whose completions are appended as governed records.',
    implemented: true,
    parseConfig: parseTaskChecklistConfig,
    summarize: (c) => {
      const cfg = c as TaskChecklistConfig;
      const from = cfg.source === 'records' ? 'the app’s own records' : cfg.source.datasetId;
      return `A checklist of items from ${from}; checking one saves a governed completion record.`;
    },
  },

  // ---- interactive patterns, coming soon (need os.records.update or the 3.5d DSL) ----
  'editable-grid': comingSoon('editable-grid', 'Editable grid', 'interactive', 'An inline-editable table that writes governed records.'),
  'kanban-workflow': comingSoon('kanban-workflow', 'Kanban workflow', 'interactive', 'A status board whose tiles can be moved between columns (writes the status).'),
  'action-detail': comingSoon('action-detail', 'Action detail', 'interactive', 'A record detail with governed actions attached.'),
};

/**
 * Structurally parse a pattern's config. `raw` is the untrusted `config` value; returns the
 * typed config or undefined (with typed issues pushed to `ctx`). Every pattern id in the enum
 * has an entry, so an unknown id can never reach here (the caller's `reqEnum` gates it).
 */
export function parsePatternConfig(ctx: Ctx, pattern: PatternId, raw: unknown, path: string): PatternConfig | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'config must be an object', `use the "${pattern}" pattern's config object`);
    return undefined;
  }
  return PATTERNS[pattern].parseConfig(ctx, raw, path);
}

/** The plain-language summary for one pattern body — the legibility surface's building block. */
export function summarizePattern(pattern: PatternId, config: PatternConfig): string {
  return PATTERNS[pattern].summarize(config);
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE per-pattern authoring schema for the COMPOSE UI (AppSpec Phase 4a).
 *
 * The composer must let the user CONFIGURE a pattern by SELECTING — pick a granted dataset, then
 * tick real columns from its schema, set labels/formats/filters from dropdowns — and NEVER type a
 * raw field name or code. To keep the React form generic + low-variance, each IMPLEMENTED pattern
 * is described here as a small, data-driven list of SLOTS (a `dataset` picker, a `single-field`
 * picker, a `multi-field` column list, a text label, a boolean, an enum), plus:
 *   • `defaultConfigFor(pattern, {datasetId})` — the config a freshly-added tab starts with, and
 *   • `slotsFor(pattern)` — the ordered slots the form renders.
 * The React layer edits the config IN PLACE (immutable copies) through these slot descriptors; the
 * assembled config is the same typed `PatternConfig` the renderer + validators consume.
 *
 * SCOPE (4a core): the VIEW patterns that read ONE dataset + `records-table`'s filters + the
 * single-source interactive `form`. Multi-dataset (`assignment`), metric-only (`chart-explorer`,
 * `kpi-overview` metric cards) and composed (`landing`) patterns render a friendly "configure in
 * Advanced / MCP" note in the form rather than a half-built control — they stay VALID (their config
 * round-trips untouched) but their rich editors are explicitly deferred. This is a tight,
 * honest surface, not a stub for every pattern.
 */

import { FORMATS, CONTROLS, type Format, type Control } from './schema.ts';
import type {
  PatternConfig,
  PatternId,
  RecordsTableConfig,
  DetailConfig,
  StatusBoardConfig,
  MasterDetailConfig,
  CardGalleryConfig,
  TimelineConfig,
  CalendarConfig,
  FormConfig,
  ChartExplorerConfig,
  KpiOverviewConfig,
  LandingConfig,
  AssignmentConfig,
  IntakeWizardConfig,
  ApprovalQueueConfig,
  TaskChecklistConfig,
} from './patterns.ts';

/** A config slot the generic form renders. Each names the config KEY it writes + how to edit it. */
export type ComposeSlot =
  /** Pick the tab's governed dataset source (writes `config.source.datasetId`). */
  | { kind: 'dataset'; key: 'source'; label: string; help?: string }
  /** Pick the app's own records OR a granted dataset (writes `config.source = 'records' | {datasetId}`). */
  | { kind: 'source-choice'; key: 'source'; label: string; help?: string }
  /** Pick a granted METRIC (writes `config[key] = { metricId }`). */
  | { kind: 'metric'; key: string; label: string; help?: string }
  /** Pick ONE field name from the source's real columns (writes `config[key]`). */
  | { kind: 'single-field'; key: string; label: string; help?: string; optional?: boolean }
  /** Tick MANY field names → a `{field,label?,format?}[]` column list (writes `config[key]`). */
  | { kind: 'columns'; key: string; label: string; help?: string; optional?: boolean }
  /** Tick MANY field names → a plain `string[]` of field names (writes `config[key]`). */
  | { kind: 'multi-field'; key: string; label: string; help?: string; optional?: boolean }
  /** A boolean toggle (writes `config[key]`). */
  | { kind: 'bool'; key: string; label: string; help?: string }
  /** A closed enum select (writes `config[key]` — a display/behaviour choice, never a field name). */
  | { kind: 'enum'; key: string; label: string; options: readonly string[]; help?: string }
  /** A short free-text label (NOT a field name — a display label, e.g. a submit button caption). */
  | { kind: 'text'; key: string; label: string; help?: string; placeholder?: string };

/** Patterns whose rich compose editor is deferred — shown with an honest note. Phase 4c gives every
 *  IMPLEMENTED pattern a rich selection-only editor, so this set is now EMPTY (kept as the seam a
 *  future not-yet-editable pattern would use). Only patterns with a non-trivial bespoke editor
 *  (KPI cards, landing blocks, wizard steps, assignment) are handled directly in the composer. */
export const COMPOSE_DEFERRED: ReadonlySet<PatternId> = new Set<PatternId>([]);

/** Patterns whose editor is a BESPOKE composer sub-form (not the generic slot list) — the composer
 *  branches to a dedicated editor for these rather than `slotsFor`. They are still fully composable. */
export const COMPOSE_BESPOKE: ReadonlySet<PatternId> = new Set<PatternId>([
  'kpi-overview', // add/remove cards (metric | dataset-agg | function) — the KPI card editor
  'landing', // an ordered block list (markdown | kpi | table) — the block editor
  'intake-wizard', // add/remove steps, each a field builder — the wizard editor
  'assignment', // two datasets (item + assignee) + extra fields — the assignment editor
]);

/** Whether the composer offers a rich, selection-only editor for this pattern (generic OR bespoke). */
export function isComposable(pattern: PatternId): boolean {
  return !COMPOSE_DEFERRED.has(pattern);
}

/** Whether this pattern uses a BESPOKE sub-editor rather than the generic slot list. */
export function isBespoke(pattern: PatternId): boolean {
  return COMPOSE_BESPOKE.has(pattern);
}

/** The ordered slots the generic form renders for a composable pattern (empty for deferred ones). */
export function slotsFor(pattern: PatternId): ComposeSlot[] {
  switch (pattern) {
    case 'records-table':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source', help: 'A dataset granted to this app.' },
        { kind: 'columns', key: 'columns', label: 'Columns', help: 'Tick the fields to show as table columns.' },
        { kind: 'multi-field', key: 'filterFields', label: 'Filter by', help: 'Fields users can filter on.', optional: true },
        { kind: 'bool', key: 'search', label: 'Show a search box' },
      ];
    case 'detail':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'keyField', label: 'Choose records by', help: 'The field that identifies each record.' },
        { kind: 'columns', key: 'fields', label: 'Fields to show' },
      ];
    case 'status-board':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'statusField', label: 'Group into columns by', help: 'The status field.' },
        { kind: 'single-field', key: 'titleField', label: 'Tile title field' },
        { kind: 'multi-field', key: 'subtitleFields', label: 'Tile subtitle fields', optional: true },
      ];
    case 'master-detail':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'keyField', label: 'Choose records by' },
        { kind: 'columns', key: 'listColumns', label: 'List columns' },
        { kind: 'columns', key: 'detailFields', label: 'Detail fields' },
      ];
    case 'card-gallery':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'titleField', label: 'Card title field' },
        { kind: 'single-field', key: 'subtitleField', label: 'Card subtitle field', optional: true },
        { kind: 'columns', key: 'fields', label: 'Extra fields on the card', optional: true },
        { kind: 'bool', key: 'search', label: 'Show a search box' },
      ];
    case 'timeline':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'dateField', label: 'Date field', help: 'Records order newest-first by this.' },
        { kind: 'single-field', key: 'titleField', label: 'Title field' },
        { kind: 'single-field', key: 'descriptionField', label: 'Description field', optional: true },
      ];
    case 'calendar':
      return [
        { kind: 'dataset', key: 'source', label: 'Data source' },
        { kind: 'single-field', key: 'dateField', label: 'Date field' },
        { kind: 'single-field', key: 'titleField', label: 'Title field' },
      ];
    case 'chart-explorer':
      return [
        { kind: 'metric', key: 'metric', label: 'Metric', help: 'A governed metric granted to this app.' },
        { kind: 'multi-field', key: 'dimensions', label: 'Break down by', help: 'Dimensions from the metric’s dataset.', optional: true },
        { kind: 'single-field', key: 'timeDimension', label: 'Time axis', help: 'A date field to plot over time.', optional: true },
        { kind: 'enum', key: 'granularity', label: 'Granularity', options: GRANULARITIES, help: 'Only used with a time axis.' },
        { kind: 'enum', key: 'chart', label: 'Chart type', options: CHART_KINDS },
      ];
    case 'approval-queue':
      return [
        { kind: 'source-choice', key: 'source', label: 'Items to approve', help: 'The app’s own records, or a granted dataset.' },
        { kind: 'single-field', key: 'titleField', label: 'Item title field' },
        { kind: 'multi-field', key: 'subtitleFields', label: 'Subtitle fields', optional: true },
        { kind: 'bool', key: 'reasonRequired', label: 'Require a reason for each decision' },
      ];
    case 'task-checklist':
      return [
        { kind: 'source-choice', key: 'source', label: 'Tasks', help: 'The app’s own records, or a granted dataset.' },
        { kind: 'single-field', key: 'titleField', label: 'Task title field' },
        { kind: 'single-field', key: 'assigneeField', label: 'Assignee field', optional: true },
      ];
    case 'form':
      return [
        { kind: 'text', key: 'submitLabel', label: 'Submit button', placeholder: 'Save', help: 'The button caption.' },
        // form fields are authored by the dedicated FormFields control (see the composer), not a slot.
      ];
    default:
      return [];
  }
}

/** Time-grain options for a chart with a time axis (a closed, safe select). */
export const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;
/** The chart kinds `chart-explorer` renders (mirrors `patterns.ts` `CHART_KINDS`). */
export const CHART_KINDS = ['line', 'bar', 'area'] as const;

/** Whether a slot key on this pattern is a COLUMN/field-name slot (so the form fetches the schema). */
export function patternNeedsColumns(pattern: PatternId): boolean {
  return slotsFor(pattern).some((s) => s.kind === 'columns' || s.kind === 'single-field' || s.kind === 'multi-field');
}

/** The dataset id currently set on a config's `source` (or undefined for a source-less pattern OR
 *  when the source is the literal `'records'` string, which is not a dataset). */
export function datasetIdOf(config: PatternConfig): string | undefined {
  const src = (config as { source?: unknown }).source;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const id = (src as { datasetId?: string }).datasetId;
    return id || undefined;
  }
  return undefined;
}

/** The metric id currently set on a config's `metric` slot (chart-explorer), or undefined. */
export function metricIdOf(config: PatternConfig): string | undefined {
  const m = (config as { metric?: { metricId?: string } }).metric;
  return m?.metricId || undefined;
}

/** A metric id is `<datasetId>.<measureName>` — its columns come from that underlying dataset. This
 *  derives the dataset id so a metric-backed pattern (chart-explorer) can reuse the SAME dataset
 *  schema cache to offer real dimension/time fields (never a typed member name). */
export function datasetIdForMetric(metricId: string | undefined): string | undefined {
  if (!metricId) return undefined;
  const i = metricId.lastIndexOf('.');
  return i > 0 ? metricId.slice(0, i) : undefined;
}

/** The dataset whose SCHEMA a pattern's field controls read from: a dataset-source pattern uses its
 *  own source; a metric-backed pattern (chart-explorer) uses the metric's underlying dataset. Returns
 *  undefined when nothing is picked yet (so the form shows "pick a source first"). */
export function columnSourceDatasetId(config: PatternConfig): string | undefined {
  return datasetIdOf(config) ?? datasetIdForMetric(metricIdOf(config));
}

// -------------------------------------------------------------- default configs ----

/** The config a freshly-added tab of this pattern starts with. A granted `datasetId` (when known)
 *  seeds the source so the tab already points at real data; columns/fields start EMPTY so the user
 *  ticks them from the fetched schema (never a guessed field name). Deferred patterns get a minimal
 *  VALID-shaped default so the spec parses; their real config is authored in Advanced/MCP. */
export function defaultConfigFor(pattern: PatternId, opts: { datasetId?: string } = {}): PatternConfig {
  const ds = opts.datasetId ?? '';
  const source = { datasetId: ds };
  switch (pattern) {
    case 'records-table':
      return { source, columns: [] } satisfies RecordsTableConfig;
    case 'detail':
      return { source, keyField: '', fields: [] } satisfies DetailConfig;
    case 'status-board':
      return { source, statusField: '', titleField: '' } satisfies StatusBoardConfig;
    case 'master-detail':
      return { source, keyField: '', listColumns: [], detailFields: [] } satisfies MasterDetailConfig;
    case 'card-gallery':
      return { source, titleField: '' } satisfies CardGalleryConfig;
    case 'timeline':
      return { source, dateField: '', titleField: '' } satisfies TimelineConfig;
    case 'calendar':
      return { source, dateField: '', titleField: '' } satisfies CalendarConfig;
    case 'form':
      return { target: 'records', fields: [], submitLabel: 'Save' } satisfies FormConfig;
    // — 4c newly-editable patterns —
    case 'chart-explorer':
      return { metric: { metricId: '' }, chart: 'line' } satisfies ChartExplorerConfig;
    case 'kpi-overview':
      return { cards: [] } satisfies KpiOverviewConfig;
    case 'landing':
      return { blocks: [] } satisfies LandingConfig;
    case 'assignment':
      return { source, itemLabelField: '', assignTo: { datasetId: '', optionLabelField: '' } } satisfies AssignmentConfig;
    case 'intake-wizard':
      return { target: 'records', steps: [], submitLabel: 'Save' } satisfies IntakeWizardConfig;
    case 'approval-queue':
      return { source: 'records', titleField: '' } satisfies ApprovalQueueConfig;
    case 'task-checklist':
      return { source: 'records', titleField: '' } satisfies TaskChecklistConfig;
    default:
      return { source } as unknown as PatternConfig;
  }
}

// ------------------------------------------------------ selection → config folding ----
// Immutable helpers the form calls when a control changes. Each returns a NEW config object.

/** Set the dataset source; when the dataset CHANGES, any column/field selections that referenced the
 *  OLD schema are cleared (a field from a different dataset can't be trusted to exist). */
export function withDataset(config: PatternConfig, datasetId: string): PatternConfig {
  const prev = datasetIdOf(config);
  const next = { ...(config as Record<string, unknown>), source: { datasetId } } as PatternConfig;
  return prev && prev !== datasetId ? clearFieldSlots(next) : next;
}

/** Non-field config keys that must survive a dataset/metric change (they are choices, not field
 *  references): the source itself, form plumbing, and closed-enum display choices. */
const NON_FIELD_KEYS = new Set(['source', 'metric', 'target', 'submitLabel', 'search', 'chart', 'granularity', 'reasonRequired']);

/** Clear every column/field-name slot (used when the dataset/metric changes under a config). Only
 *  field-referencing slots (strings + arrays that name real columns) are cleared; source/enum/plumbing
 *  keys survive. */
function clearFieldSlots(config: PatternConfig): PatternConfig {
  const c = { ...(config as Record<string, unknown>) };
  for (const key of Object.keys(c)) {
    if (NON_FIELD_KEYS.has(key)) continue;
    const v = c[key];
    if (Array.isArray(v)) c[key] = [];
    else if (typeof v === 'string') c[key] = '';
  }
  return c as PatternConfig;
}

/** Set a single-field slot (writes `config[key] = fieldName`, '' clears it). */
export function withSingleField(config: PatternConfig, key: string, field: string): PatternConfig {
  return { ...(config as Record<string, unknown>), [key]: field } as PatternConfig;
}

/** Set a boolean slot. */
export function withBool(config: PatternConfig, key: string, value: boolean): PatternConfig {
  return { ...(config as Record<string, unknown>), [key]: value } as PatternConfig;
}

/** Set a free-text slot (label/caption — never a field name). */
export function withText(config: PatternConfig, key: string, value: string): PatternConfig {
  return { ...(config as Record<string, unknown>), [key]: value } as PatternConfig;
}

/** Set an enum slot (a closed-select choice — chart type, granularity). '' clears it. */
export function withEnum(config: PatternConfig, key: string, value: string): PatternConfig {
  const c = { ...(config as Record<string, unknown>) };
  if (value === '') delete c[key];
  else c[key] = value;
  return c as PatternConfig;
}

/** Set the METRIC slot (writes `config[key] = { metricId }`); changing the metric clears the
 *  dimension/time field selections that referenced the OLD metric's dataset. */
export function withMetric(config: PatternConfig, key: string, metricId: string): PatternConfig {
  const prev = metricIdOf(config);
  const next = { ...(config as Record<string, unknown>), [key]: { metricId } } as PatternConfig;
  if (prev && datasetIdForMetric(prev) !== datasetIdForMetric(metricId)) {
    return clearFieldSlots(next);
  }
  return next;
}

/** Set an interactive `source-choice` slot to the app's own records (writes `source: 'records'`). */
export function withRecordsSource(config: PatternConfig): PatternConfig {
  const prev = datasetIdOf(config);
  const next = { ...(config as Record<string, unknown>), source: 'records' } as PatternConfig;
  return prev ? clearFieldSlots(next) : next;
}

/** Set an interactive `source-choice` slot to a granted dataset (writes `source: {datasetId}`);
 *  switching the dataset (or away from records) clears the field selections that named old columns. */
export function withDatasetSource(config: PatternConfig, datasetId: string): PatternConfig {
  const prev = datasetIdOf(config);
  const wasRecords = (config as { source?: unknown }).source === 'records';
  const next = { ...(config as Record<string, unknown>), source: { datasetId } } as PatternConfig;
  return (prev && prev !== datasetId) || wasRecords ? clearFieldSlots(next) : next;
}

/** Whether an interactive config's source is currently the app's own records (vs a dataset). */
export function sourceIsRecords(config: PatternConfig): boolean {
  return (config as { source?: unknown }).source === 'records';
}

/** Set a `multi-field` slot to a plain `string[]` of ticked field names (dropping empties). */
export function withMultiField(config: PatternConfig, key: string, fields: string[]): PatternConfig {
  const clean = fields.filter((f) => f && f.trim() !== '');
  return { ...(config as Record<string, unknown>), [key]: clean } as PatternConfig;
}

/** Set a `columns` slot from ticked field names, PRESERVING any label/format the user already set on
 *  a still-ticked column (so re-ticking a column doesn't wipe its format). New columns get no
 *  label/format (the field name is shown as-is). Order follows the ticked-order argument. */
export function withColumns(config: PatternConfig, key: string, fields: string[]): PatternConfig {
  const existing = (config as Record<string, unknown>)[key];
  const byField = new Map<string, { field: string; label?: string; format?: Format }>();
  if (Array.isArray(existing)) {
    for (const c of existing as { field?: string; label?: string; format?: Format }[]) {
      if (c && typeof c.field === 'string') byField.set(c.field, { field: c.field, ...(c.label ? { label: c.label } : {}), ...(c.format ? { format: c.format } : {}) });
    }
  }
  const cols = fields
    .filter((f) => f && f.trim() !== '')
    .map((f) => byField.get(f) ?? { field: f });
  return { ...(config as Record<string, unknown>), [key]: cols } as PatternConfig;
}

/** Set ONE column's `format` inside a `columns` slot (leaves the rest untouched). */
export function withColumnFormat(config: PatternConfig, key: string, field: string, format: Format | ''): PatternConfig {
  const existing = (config as Record<string, unknown>)[key];
  if (!Array.isArray(existing)) return config;
  const cols = (existing as { field: string; label?: string; format?: Format }[]).map((c) =>
    c.field === field
      ? format
        ? { ...c, format }
        : dropFormat(c)
      : c,
  );
  return { ...(config as Record<string, unknown>), [key]: cols } as PatternConfig;
}

function dropFormat(c: { field: string; label?: string; format?: Format }): { field: string; label?: string } {
  const { format: _f, ...rest } = c;
  void _f;
  return rest;
}

/** The `records-table` FILTER slot is stored as `filters: {field,control}[]`. The `multi-field`
 *  slot on the form ticks WHICH fields are filterable; this folds that into the filters array,
 *  keeping any control the user already chose and defaulting new ones to 'search'. */
export function withFilterFields(config: PatternConfig, fields: string[]): RecordsTableConfig {
  const cfg = config as RecordsTableConfig;
  const prev = cfg.filters ?? [];
  const byField = new Map(prev.map((f) => [f.field, f]));
  const filters = fields
    .filter((f) => f && f.trim() !== '')
    .map((f): { field: string; control: Control } => byField.get(f) ?? { field: f, control: 'search' });
  const next: RecordsTableConfig = { ...cfg };
  if (filters.length > 0) next.filters = filters;
  else delete next.filters;
  return next;
}

/** Set ONE filter's control (select/search/range). No-op when the field isn't a filter. */
export function withFilterControl(config: PatternConfig, field: string, control: Control): RecordsTableConfig {
  const cfg = config as RecordsTableConfig;
  const filters = (cfg.filters ?? []).map((f) => (f.field === field ? { ...f, control } : f));
  return { ...cfg, ...(filters.length > 0 ? { filters } : {}) };
}

/** Read the current filter field names off a records-table config (for the multi-field control). */
export function filterFieldsOf(config: PatternConfig): string[] {
  const cfg = config as RecordsTableConfig;
  return (cfg.filters ?? []).map((f) => f.field);
}

/** Re-export the closed enums the form's dropdowns render. */
export const FORMAT_OPTIONS: readonly Format[] = FORMATS;
export const CONTROL_OPTIONS: readonly Control[] = CONTROLS;

/**
 * Extract the STRING column names from a dataset-detail API column list. The API returns column
 * DOCS (`{ name, description }[]`) for BOTH `columns` and `goldColumns` (`goldOutputColumns` →
 * `ColumnDoc[]`). The composer's field pickers render these directly as `<option>`/`<span>` children,
 * so they MUST be strings — a raw `{name, description}` object as a JSX child is React error #31.
 * This maps each entry to its `name`, dropping any blank/malformed one. Pure → unit-tested so the
 * "column object rendered as a child" crash can never regress.
 */
export function extractColumnNames(cols: unknown): string[] {
  if (!Array.isArray(cols)) return [];
  const out: string[] = [];
  for (const c of cols) {
    if (typeof c === 'string') {
      if (c.trim() !== '') out.push(c);
    } else if (c && typeof c === 'object') {
      const name = (c as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim() !== '') out.push(name);
    }
  }
  return out;
}

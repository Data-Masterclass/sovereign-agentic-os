/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE reducers for the COMPOSE UI's BESPOKE sub-editors (AppSpec Phase 4c).
 *
 * A few patterns need more than the generic slot list: `kpi-overview` (a list of cards, each a
 * metric | dataset-aggregate | function source), `landing` (an ordered list of markdown / kpi /
 * table blocks), `intake-wizard` (steps, each a field builder), and the app-wide `functions[]`
 * (aggregate | expression) that a KPI card can reference. This module is the DOM-free heart of those:
 * immutable list reducers (add / update / remove / move a card, block, step, field, or function) and
 * small VALID-shaped factories. The React layer only ever SELECTS values into these shapes — it never
 * types a field name or code (the one legitimate free-text is a `form`/wizard field the user is
 * DEFINING, or an expression referencing `fn.<id>`, both explicitly validated) — so what the user
 * builds round-trips through `parseAppSpec` + `validateAppSpec` unchanged.
 *
 * Everything is a pure function of its input → trivially unit-tested; no DOM, no fetch.
 */

import type {
  KpiCard,
  KpiAgg,
  LandingBlock,
  WizardStep,
  IntakeWizardConfig,
  KpiOverviewConfig,
  LandingConfig,
} from './patterns.ts';
import type { FormField, TableColumn, FieldType } from './schema.ts';
import type { AppFunction, AggregateFunction, ExpressionFunction, AggOp } from './functions-schema.ts';

// -------------------------------------------------------------- generic list helpers ----
// Small immutable array primitives the sub-editors share (add/update/remove/move by index).

/** Replace the item at `i` with `next` (a no-op when out of range). Pure. */
function replaceAt<T>(list: readonly T[], i: number, next: T): T[] {
  if (i < 0 || i >= list.length) return [...list];
  return list.map((x, j) => (j === i ? next : x));
}

/** Remove the item at `i` (a no-op when out of range). Pure. */
function removeAt<T>(list: readonly T[], i: number): T[] {
  if (i < 0 || i >= list.length) return [...list];
  return list.filter((_, j) => j !== i);
}

/** Move the item at `i` by `delta` (-1 up / +1 down), clamped. Pure. */
function moveBy<T>(list: readonly T[], i: number, delta: number): T[] {
  const to = i + delta;
  if (i < 0 || i >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [moved] = out.splice(i, 1);
  out.splice(to, 0, moved);
  return out;
}

// -------------------------------------------------------------------- KPI cards ----
// A card is EXACTLY ONE of: a governed metric, a dataset aggregate, or a declared function value.

/** A fresh, minimal-VALID metric card (no source yet — the user picks the metric next). */
export function newMetricCard(label = ''): KpiCard {
  return { label, metric: { metricId: '' } };
}

/** A fresh dataset-aggregate card defaulting to a `count` (needs no field). */
export function newDatasetCard(label = ''): KpiCard {
  return { label, dataset: { datasetId: '', agg: 'count' } };
}

/** A fresh function card referencing a declared `functions[]` id. */
export function newFunctionCard(label = '', functionId = ''): KpiCard {
  return { label, function: { functionId } };
}

/** Which of the three sources a card currently uses (drives the editor's source toggle). */
export function cardSource(card: KpiCard): 'metric' | 'dataset' | 'function' {
  if (card.dataset) return 'dataset';
  if (card.function) return 'function';
  return 'metric';
}

/** Set a card's label. */
export function setCardLabel(card: KpiCard, label: string): KpiCard {
  return { ...card, label };
}

/** Switch a card to a different source kind, resetting that source to its empty-VALID default and
 *  DROPPING the other two (a card must carry exactly one source). */
export function setCardSourceKind(card: KpiCard, kind: 'metric' | 'dataset' | 'function'): KpiCard {
  const base = { label: card.label };
  if (kind === 'metric') return { ...base, metric: { metricId: '' } };
  if (kind === 'dataset') return { ...base, dataset: { datasetId: '', agg: 'count' } };
  return { ...base, function: { functionId: '' } };
}

/** Set a metric card's metric id. */
export function setCardMetric(card: KpiCard, metricId: string): KpiCard {
  return { label: card.label, metric: { metricId } };
}

/** Set a function card's function id. */
export function setCardFunction(card: KpiCard, functionId: string): KpiCard {
  return { label: card.label, function: { functionId } };
}

/** Set a dataset card's dataset id (keeping its agg/field). */
export function setCardDataset(card: KpiCard, datasetId: string): KpiCard {
  const d = card.dataset ?? { datasetId: '', agg: 'count' as KpiAgg };
  return { label: card.label, dataset: { ...d, datasetId } };
}

/** Set a dataset card's aggregation. `count` drops the field (it needs none); sum/avg keep it. */
export function setCardAgg(card: KpiCard, agg: KpiAgg): KpiCard {
  const d = card.dataset ?? { datasetId: '', agg };
  if (agg === 'count') {
    const { field: _drop, ...rest } = d;
    void _drop;
    return { label: card.label, dataset: { ...rest, agg } };
  }
  return { label: card.label, dataset: { ...d, agg, field: d.field ?? '' } };
}

/** Set a dataset card's aggregated field (only meaningful for sum/avg). */
export function setCardField(card: KpiCard, field: string): KpiCard {
  const d = card.dataset ?? { datasetId: '', agg: 'sum' as KpiAgg };
  return { label: card.label, dataset: { ...d, field } };
}

/** Immutable KPI-card list reducers (used by both `kpi-overview` and a landing `kpi` block). */
export const kpiCards = {
  add: (cards: readonly KpiCard[], card: KpiCard): KpiCard[] => [...cards, card],
  update: (cards: readonly KpiCard[], i: number, card: KpiCard): KpiCard[] => replaceAt(cards, i, card),
  remove: (cards: readonly KpiCard[], i: number): KpiCard[] => removeAt(cards, i),
  move: (cards: readonly KpiCard[], i: number, delta: number): KpiCard[] => moveBy(cards, i, delta),
};

/** Read/write a `kpi-overview` config's card list through the shared reducers. */
export function withKpiCards(cfg: KpiOverviewConfig, cards: KpiCard[]): KpiOverviewConfig {
  return { ...cfg, cards };
}

// -------------------------------------------------------------------- landing blocks ----

/** A fresh markdown block (prose). */
export function newMarkdownBlock(content = ''): LandingBlock {
  return { kind: 'markdown', content };
}
/** A fresh KPI block (its own card list). */
export function newKpiBlock(): LandingBlock {
  return { kind: 'kpi', cards: [] };
}
/** A fresh table block over a dataset (columns ticked from its schema). */
export function newTableBlock(datasetId = ''): LandingBlock {
  return { kind: 'table', source: { datasetId }, columns: [] };
}

/** Immutable landing-block list reducers. */
export const landingBlocks = {
  add: (blocks: readonly LandingBlock[], block: LandingBlock): LandingBlock[] => [...blocks, block],
  update: (blocks: readonly LandingBlock[], i: number, block: LandingBlock): LandingBlock[] => replaceAt(blocks, i, block),
  remove: (blocks: readonly LandingBlock[], i: number): LandingBlock[] => removeAt(blocks, i),
  move: (blocks: readonly LandingBlock[], i: number, delta: number): LandingBlock[] => moveBy(blocks, i, delta),
};

/** Read/write a `landing` config's block list. */
export function withLandingBlocks(cfg: LandingConfig, blocks: LandingBlock[]): LandingConfig {
  return { ...cfg, blocks };
}

/** Set a markdown block's content (no-op if the block isn't markdown). */
export function setMarkdownContent(block: LandingBlock, content: string): LandingBlock {
  return block.kind === 'markdown' ? { kind: 'markdown', content } : block;
}
/** Set a kpi block's cards. */
export function setKpiBlockCards(block: LandingBlock, cards: KpiCard[]): LandingBlock {
  return block.kind === 'kpi' ? { kind: 'kpi', cards } : block;
}
/** Set a table block's dataset (clearing its columns, which named the old schema). */
export function setTableBlockDataset(block: LandingBlock, datasetId: string): LandingBlock {
  return block.kind === 'table' ? { kind: 'table', source: { datasetId }, columns: [] } : block;
}
/** Set a table block's columns from ticked field names. */
export function setTableBlockColumns(block: LandingBlock, columns: TableColumn[]): LandingBlock {
  return block.kind === 'table' ? { ...block, columns } : block;
}

// -------------------------------------------------------------------- wizard steps ----
// A step is a titled group of form fields the user DEFINES (name/label/type/required) — the fields
// are NEW data the app collects into a governed record, so a text `name` is legitimate here.

/** A fresh wizard step with an empty field list. */
export function newWizardStep(title = ''): WizardStep {
  return { title, fields: [] };
}
/** A fresh form field (text by default). */
export function newFormField(): FormField {
  return { name: '', label: '', type: 'text' };
}

/** Immutable wizard-step list reducers. */
export const wizardSteps = {
  add: (steps: readonly WizardStep[], step: WizardStep): WizardStep[] => [...steps, step],
  update: (steps: readonly WizardStep[], i: number, step: WizardStep): WizardStep[] => replaceAt(steps, i, step),
  remove: (steps: readonly WizardStep[], i: number): WizardStep[] => removeAt(steps, i),
  move: (steps: readonly WizardStep[], i: number, delta: number): WizardStep[] => moveBy(steps, i, delta),
};

/** Set a step's title. */
export function setStepTitle(step: WizardStep, title: string): WizardStep {
  return { ...step, title };
}
/** Immutable field-list reducers (used within a step AND for a single-screen `form`). */
export const formFields = {
  add: (fields: readonly FormField[], field: FormField): FormField[] => [...fields, field],
  update: (fields: readonly FormField[], i: number, field: FormField): FormField[] => replaceAt(fields, i, field),
  remove: (fields: readonly FormField[], i: number): FormField[] => removeAt(fields, i),
  move: (fields: readonly FormField[], i: number, delta: number): FormField[] => moveBy(fields, i, delta),
};
/** Set one attribute of a field (name/label/type/required), returning a new field. */
export function setFieldAttr(
  field: FormField,
  attr: 'name' | 'label' | 'type' | 'required',
  value: string | boolean,
): FormField {
  if (attr === 'required') return { ...field, required: !!value };
  if (attr === 'type') return { ...field, type: value as FieldType };
  return { ...field, [attr]: String(value) };
}

/** Read/write an `intake-wizard` config's steps. */
export function withWizardSteps(cfg: IntakeWizardConfig, steps: WizardStep[]): IntakeWizardConfig {
  return { ...cfg, steps };
}

// -------------------------------------------------------------------- functions[] ----
// The app-wide governed DSL functions a KPI card can reference (aggregate | expression). Selection
// only: an aggregate picks dataset + op + field; an expression is a typed formula over `fn.<id>`.

/** A short, valid function id token (lowercase alnum + dashes). */
export function newFunctionId(seed = 'fn'): string {
  return `${seed}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A fresh aggregate function (count → needs no field). */
export function newAggregateFunction(): AggregateFunction {
  const id = newFunctionId();
  return { id, name: '', description: '', kind: 'aggregate', source: { datasetId: '' }, op: 'count' };
}
/** A fresh expression function (an empty formula the user fills). */
export function newExpressionFunction(): ExpressionFunction {
  const id = newFunctionId();
  return { id, name: '', description: '', kind: 'expression', expr: '' };
}

/** Immutable function-list reducers. */
export const appFunctions = {
  add: (fns: readonly AppFunction[], fn: AppFunction): AppFunction[] => [...fns, fn],
  update: (fns: readonly AppFunction[], i: number, fn: AppFunction): AppFunction[] => replaceAt(fns, i, fn),
  remove: (fns: readonly AppFunction[], i: number): AppFunction[] => removeAt(fns, i),
  move: (fns: readonly AppFunction[], i: number, delta: number): AppFunction[] => moveBy(fns, i, delta),
};

/** Set a function's name or description (the shared header). */
export function setFunctionHeader(fn: AppFunction, key: 'name' | 'description', value: string): AppFunction {
  return { ...fn, [key]: value };
}

/** Switch a function between aggregate/expression, resetting to that kind's empty-VALID default but
 *  KEEPING the id/name/description so a mistaken toggle doesn't lose the labelling. */
export function setFunctionKind(fn: AppFunction, kind: 'aggregate' | 'expression'): AppFunction {
  const header = { id: fn.id, name: fn.name, description: fn.description };
  if (kind === 'aggregate') return { ...header, kind: 'aggregate', source: { datasetId: '' }, op: 'count' };
  return { ...header, kind: 'expression', expr: '' };
}

/** Set an aggregate function's dataset. */
export function setAggDataset(fn: AppFunction, datasetId: string): AppFunction {
  if (fn.kind !== 'aggregate') return fn;
  return { ...fn, source: { datasetId } };
}
/** Set an aggregate function's op. `count` drops the field; numeric ops keep/require one. */
export function setAggOp(fn: AppFunction, op: AggOp): AppFunction {
  if (fn.kind !== 'aggregate') return fn;
  if (op === 'count') {
    const { field: _drop, ...rest } = fn;
    void _drop;
    return { ...rest, op };
  }
  return { ...fn, op, field: fn.field ?? '' };
}
/** Set an aggregate function's field (meaningful for sum/avg/min/max). */
export function setAggField(fn: AppFunction, field: string): AppFunction {
  if (fn.kind !== 'aggregate') return fn;
  return { ...fn, field };
}
/** Set an expression function's formula. */
export function setExpr(fn: AppFunction, expr: string): AppFunction {
  if (fn.kind !== 'expression') return fn;
  return { ...fn, expr };
}

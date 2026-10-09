/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * compose.test — the PURE compose logic for the Build-stage authoring UI (AppSpec Phase 4a).
 *
 * Covers: `composeSpec` (editor state → a spec `parseAppSpec` accepts), tab add/remove/reorder/
 * rename/pattern-swap, default configs, selection→config folding, issue-path → tab/slot mapping,
 * and a full ROUND TRIP: build a records-table + detail spec purely from field SELECTIONS, then
 * assert `parseAppSpec` + the semantic `validateAppSpec` both accept it (seeding a real dataset via
 * the store the same way validate.test.ts does).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, setDocs, transition, defineMeasure, type Principal } from '../../data/store.ts';
import { parseAppSpec, type AppSpec, type SpecIssue } from './schema.ts';
import { validateAppSpec } from './validate.ts';
import type { App } from '../apps.ts';
import {
  initialState,
  addTab,
  removeTab,
  moveTab,
  renameTab,
  setTabPattern,
  setTabConfig,
  setTabStories,
  setTabRoleGate,
  setTabCustom,
  clearTabCustom,
  setThemeCss,
  setFunctions,
  composeSpec,
  stateFromSpec,
  type ComposeState,
} from './compose-model.ts';
import {
  defaultConfigFor,
  slotsFor,
  isComposable,
  isBespoke,
  withDataset,
  withSingleField,
  withColumns,
  withColumnFormat,
  withMultiField,
  withBool,
  withText,
  withEnum,
  withMetric,
  withRecordsSource,
  withDatasetSource,
  sourceIsRecords,
  withFilterFields,
  withFilterControl,
  filterFieldsOf,
  datasetIdOf,
  metricIdOf,
  datasetIdForMetric,
  columnSourceDatasetId,
  extractColumnNames,
  COMPOSE_DEFERRED,
} from './compose-fields.ts';
import {
  newMetricCard,
  newDatasetCard,
  newFunctionCard,
  cardSource,
  setCardAgg,
  setCardField,
  setCardDataset,
  kpiCards,
  withKpiCards,
  newMarkdownBlock,
  newKpiBlock,
  newTableBlock,
  landingBlocks,
  setMarkdownContent,
  setTableBlockColumns,
  withLandingBlocks,
  newWizardStep,
  newFormField,
  wizardSteps,
  formFields,
  setFieldAttr,
  setStepTitle,
  withWizardSteps,
  newAggregateFunction,
  newExpressionFunction,
  appFunctions,
  setFunctionHeader,
  setFunctionKind,
  setAggDataset,
  setAggOp,
  setAggField,
  setExpr,
} from './compose-blocks.ts';
import {
  targetForPath,
  locateIssues,
  issuesForTab,
  issuesForSlot,
  issuesForFunction,
  hasBlockingErrors,
} from './compose-issues.ts';
import type {
  RecordsTableConfig,
  DetailConfig,
  ChartExplorerConfig,
  KpiOverviewConfig,
  LandingConfig,
  AssignmentConfig,
  IntakeWizardConfig,
  ApprovalQueueConfig,
  TaskChecklistConfig,
} from './patterns.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };

beforeEach(() => __resetStore());

/** Seed a promoted "Orders" dataset with documented columns; returns its id. */
function seedOrders(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  setDocs(d.id, amir, {
    columns: [
      { name: 'order_id', description: 'PK' },
      { name: 'net_amount', description: 'Money' },
      { name: 'status', description: 'State' },
    ],
  });
  transition(d.id, amir, 'promote');
  return d.id;
}

/** Seed a `sum(net_amount)` measure on a dataset; returns the metric id. */
function seedMetric(datasetId: string, name = 'revenue'): string {
  defineMeasure(datasetId, amir, { name, type: 'sum', sql: 'net_amount' });
  return `${datasetId}.${name}`;
}

/** Seed a second promoted dataset (a distinct name) with a `person_id`/`name` schema. */
function seedPeople(): string {
  const d = createDataset(amir, { name: 'People' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/people.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_people.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/people.sql' });
  setDocs(d.id, amir, { columns: [{ name: 'person_id', description: 'PK' }, { name: 'name', description: 'Name' }] });
  transition(d.id, amir, 'promote');
  return d.id;
}

/** A minimal App the validator reads (grants + epics). */
function appWith(dataIds: string[], metricIds: string[] = []): App {
  return {
    grants: { data: dataIds.map((id) => ({ id })), metrics: metricIds.map((id) => ({ id })) },
    epics: [],
  } as unknown as App;
}

/** Parse-then-validate a composed state; returns the validate result (asserts a clean parse). */
async function acceptedBy(state: ComposeState, app: App): Promise<{ issues: SpecIssue[]; warnings: SpecIssue[] }> {
  const parsed = parseAppSpec(composeSpec(state));
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify((parsed as { issues: SpecIssue[] }).issues));
  return validateAppSpec(app, (parsed as { ok: true; spec: AppSpec }).spec, amir);
}

// ---------------------------------------------------------------- composeSpec ----

test('composeSpec folds editor state into a valid AppSpec (v2)', () => {
  const state = initialState({ name: 'Orders App', description: 'Track orders', firstDatasetId: 'ds_1' });
  const spec = composeSpec(state);
  assert.equal(spec.version, 2);
  assert.equal(spec.name, 'Orders App');
  assert.equal(spec.tabs.length, 1);
  assert.equal(spec.tabs[0].body.kind, 'pattern');
});

test('composeSpec omits empty theme + tab optionals for a byte-minimal spec', () => {
  const state = initialState({ name: 'A', description: 'b' });
  const spec = composeSpec(state);
  assert.equal('theme' in spec, false);
  assert.equal('icon' in spec.tabs[0], false);
  assert.equal('roleGate' in spec.tabs[0], false);
  assert.equal('stories' in spec.tabs[0], false);
});

test('composeSpec emits theme, roleGate + stories when set', () => {
  let state = initialState({ name: 'A', description: 'b' });
  state = { ...state, themeCss: '.x { color: red }' };
  state = setTabRoleGate(state, 0, 'builder');
  state = setTabStories(state, 0, [{ epicId: 'e1', storyId: 's1' }]);
  const spec = composeSpec(state);
  assert.equal(spec.theme?.css, '.x { color: red }');
  assert.equal(spec.tabs[0].roleGate, 'builder');
  assert.deepEqual(spec.tabs[0].stories, [{ epicId: 'e1', storyId: 's1' }]);
});

// ---------------------------------------------------------------- tab reducers ----

test('addTab appends a tab with default config', () => {
  const s0 = initialState({ name: 'A', description: 'b' });
  const s1 = addTab(s0, 'detail', { datasetId: 'ds_1' });
  assert.equal(s1.tabs.length, 2);
  assert.equal(s1.tabs[1].pattern, 'detail');
  assert.equal(datasetIdOf(s1.tabs[1].config), 'ds_1');
  // immutability
  assert.equal(s0.tabs.length, 1);
});

test('removeTab drops a tab but never the last one', () => {
  let s = initialState({ name: 'A', description: 'b' });
  s = addTab(s, 'detail', {});
  s = removeTab(s, 0);
  assert.equal(s.tabs.length, 1);
  const last = removeTab(s, 0);
  assert.equal(last.tabs.length, 1, 'the last tab is kept');
});

test('moveTab reorders and clamps', () => {
  let s = initialState({ name: 'A', description: 'b' });
  s = addTab(s, 'detail', {});
  s = addTab(s, 'calendar', {});
  const ids = s.tabs.map((t) => t.pattern);
  const moved = moveTab(s, 0, 1);
  assert.deepEqual(moved.tabs.map((t) => t.pattern), [ids[1], ids[0], ids[2]]);
  // out-of-range delta is a no-op
  assert.deepEqual(moveTab(s, 0, -1).tabs.map((t) => t.pattern), ids);
});

test('renameTab sets the label', () => {
  const s = renameTab(initialState({ name: 'A', description: 'b' }), 0, 'My Records');
  assert.equal(s.tabs[0].label, 'My Records');
});

test('setTabPattern resets config to the new pattern default, carrying the dataset', () => {
  let s = initialState({ name: 'A', description: 'b', firstDatasetId: 'ds_1' });
  s = setTabPattern(s, 0, 'detail', 'ds_1');
  assert.equal(s.tabs[0].pattern, 'detail');
  const cfg = s.tabs[0].config as DetailConfig;
  assert.equal(cfg.source.datasetId, 'ds_1');
  assert.deepEqual(cfg.fields, []);
});

// -------------------------------------------------------- default configs / slots ----

test('defaultConfigFor produces a valid-shaped starting config per pattern', () => {
  assert.deepEqual(defaultConfigFor('records-table', { datasetId: 'd' }), { source: { datasetId: 'd' }, columns: [] });
  assert.deepEqual(defaultConfigFor('form'), { target: 'records', fields: [], submitLabel: 'Save' });
});

test('slotsFor lists selection slots for composable patterns', () => {
  assert.ok(slotsFor('records-table').some((s) => s.kind === 'columns'));
  assert.equal(isComposable('records-table'), true);
  // 4c: chart-explorer is now composable (metric + dimension slots), not deferred.
  assert.equal(isComposable('chart-explorer'), true);
  assert.ok(slotsFor('chart-explorer').some((s) => s.kind === 'metric'));
  // bespoke patterns have no generic slots (their own sub-editor renders instead).
  assert.deepEqual(slotsFor('kpi-overview'), []);
});

// -------------------------------------------------- selection → config folding ----

test('withColumns keeps existing format when a column stays ticked', () => {
  let cfg = defaultConfigFor('records-table', { datasetId: 'd' });
  cfg = withColumns(cfg, 'columns', ['order_id', 'net_amount']);
  cfg = withColumnFormat(cfg, 'columns', 'net_amount', 'currency-eur');
  cfg = withColumns(cfg, 'columns', ['order_id', 'net_amount', 'status']); // re-tick + add
  const cols = (cfg as RecordsTableConfig).columns;
  assert.equal(cols.find((c) => c.field === 'net_amount')?.format, 'currency-eur');
  assert.equal(cols.length, 3);
});

test('withDataset clears field selections when the dataset changes', () => {
  let cfg = defaultConfigFor('detail', { datasetId: 'd1' });
  cfg = withSingleField(cfg, 'keyField', 'order_id');
  cfg = withColumns(cfg, 'fields', ['net_amount']);
  cfg = withDataset(cfg, 'd2');
  const d = cfg as DetailConfig;
  assert.equal(d.source.datasetId, 'd2');
  assert.equal(d.keyField, '');
  assert.deepEqual(d.fields, []);
});

test('records-table filter helpers round-trip field ↔ control', () => {
  let cfg = defaultConfigFor('records-table', { datasetId: 'd' });
  cfg = withFilterFields(cfg, ['status']);
  assert.deepEqual(filterFieldsOf(cfg), ['status']);
  cfg = withFilterControl(cfg, 'status', 'select');
  assert.equal((cfg as RecordsTableConfig).filters?.[0].control, 'select');
  cfg = withFilterFields(cfg, []); // untick all → filters removed
  assert.equal((cfg as RecordsTableConfig).filters, undefined);
});

test('withBool / withText / withMultiField set their slots', () => {
  let cfg = defaultConfigFor('records-table', { datasetId: 'd' });
  cfg = withBool(cfg, 'search', true);
  assert.equal((cfg as RecordsTableConfig).search, true);
  let form = defaultConfigFor('form');
  form = withText(form, 'submitLabel', 'Create');
  assert.equal((form as { submitLabel: string }).submitLabel, 'Create');
  let board = defaultConfigFor('status-board', { datasetId: 'd' });
  board = withMultiField(board, 'subtitleFields', ['a', '', 'b']);
  assert.deepEqual((board as { subtitleFields: string[] }).subtitleFields, ['a', 'b']);
});

// ---------------------------------------------------------- issue → control map ----

test('targetForPath maps app-level, tab-level and config-slot paths', () => {
  assert.deepEqual(targetForPath('name'), { scope: 'app', field: 'name' });
  assert.deepEqual(targetForPath('theme.css'), { scope: 'app', field: 'theme' });
  assert.deepEqual(targetForPath('tabs[2].label'), { scope: 'tab', tabIndex: 2, slot: 'label' });
  assert.deepEqual(targetForPath('tabs[1].body.pattern'), { scope: 'tab', tabIndex: 1, slot: 'pattern' });
  assert.deepEqual(targetForPath('tabs[0].body.config.columns[3].field'), {
    scope: 'tab',
    tabIndex: 0,
    slot: 'columns',
    field: 'field',
  });
  assert.deepEqual(targetForPath(''), { scope: 'unknown' });
});

test('locateIssues + selectors attribute issues to the owning tab/slot', () => {
  const issues: SpecIssue[] = [
    { path: 'tabs[0].body.config.columns[0].field', reason: 'unknown column "foo"', fix: 'pick a real column' },
    { path: 'name', reason: 'name required', fix: 'set a name' },
  ];
  const warnings = [{ path: 'tabs[0].body.config.source.datasetId', reason: 'personal dataset', fix: 'promote' }];
  const located = locateIssues(issues, warnings);
  assert.equal(hasBlockingErrors(located), true);
  assert.equal(issuesForTab(located, 0).length, 2); // the error + the warning
  assert.equal(issuesForSlot(located, 0, 'columns').length, 1);
  assert.equal(issuesForSlot(located, 0, 'source').length, 1);
});

// ------------------------------------------------------------------ round trip ----

test('ROUND TRIP: a composed records-table + detail spec passes parse + validate', async () => {
  const ds = seedOrders();

  // Build the state purely by SELECTING — a records-table tab + a detail tab, both on the dataset.
  let state: ComposeState = initialState({ name: 'Orders', description: 'Track orders', firstDatasetId: ds });

  // Tab 0: records-table — tick real columns + a filter + search.
  let t0 = withColumns(state.tabs[0].config, 'columns', ['order_id', 'net_amount', 'status']);
  t0 = withColumnFormat(t0, 'columns', 'net_amount', 'currency-eur');
  t0 = withFilterFields(t0, ['status']);
  t0 = withFilterControl(t0, 'status', 'select');
  t0 = withBool(t0, 'search', true);
  state = setTabConfig(state, 0, t0);
  state = renameTab(state, 0, 'All orders');

  // Tab 1: detail — pick a key field + fields.
  state = addTab(state, 'detail', { datasetId: ds });
  let t1 = withSingleField(state.tabs[1].config, 'keyField', 'order_id');
  t1 = withColumns(t1, 'fields', ['net_amount', 'status']);
  state = setTabConfig(state, 1, t1);

  const spec: AppSpec = composeSpec(state);

  // Structural gate.
  const parsed = parseAppSpec(spec);
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify((parsed as { issues: SpecIssue[] }).issues));

  // Semantic gate against the real store.
  const { issues, warnings } = await validateAppSpec(appWith([ds]), (parsed as { ok: true; spec: AppSpec }).spec, amir);
  assert.deepEqual(issues, [], `expected no blocking issues, got ${JSON.stringify(issues)}`);
  // (a promoted Gold dataset is domain-readable → no personal-owner warning)
  assert.deepEqual(warnings, []);
});

test('ROUND TRIP: an unticked column produces a validate issue mapped to its tab/slot', async () => {
  const ds = seedOrders();
  let state = initialState({ name: 'Orders', description: 'x', firstDatasetId: ds });
  // Tick a column that does NOT exist by editing the config directly (simulating stale schema).
  const bad = withColumns(state.tabs[0].config, 'columns', ['order_id', 'ghost_col']);
  state = setTabConfig(state, 0, bad);

  const parsed = parseAppSpec(composeSpec(state));
  assert.equal(parsed.ok, true);
  const { issues } = await validateAppSpec(appWith([ds]), (parsed as { ok: true; spec: AppSpec }).spec, amir);
  assert.ok(issues.length > 0, 'ghost column should be rejected');
  const located = locateIssues(issues, []);
  const onTab0 = issuesForTab(located, 0);
  assert.ok(onTab0.length > 0, 'the issue is attributed to tab 0');
  assert.ok(onTab0.some((l) => l.target.scope === 'tab' && l.target.slot === 'columns'));
});

test('stateFromSpec re-hydrates the editor from a saved spec', () => {
  const state = initialState({ name: 'Orders', description: 'x', firstDatasetId: 'd' });
  const withCols = setTabConfig(state, 0, withColumns(state.tabs[0].config, 'columns', ['a', 'b']));
  const spec = composeSpec(withCols);
  const round = stateFromSpec(spec);
  assert.equal(round.name, 'Orders');
  assert.equal(round.tabs.length, 1);
  assert.equal((round.tabs[0].config as RecordsTableConfig).columns.length, 2);
});

// ============================================================ Phase 4c ==========

// ------------------------------------------------- 4c: every pattern composable ----

test('4c: no implemented pattern is deferred anymore — all are composable', () => {
  assert.equal(COMPOSE_DEFERRED.size, 0);
  for (const p of ['chart-explorer', 'kpi-overview', 'landing', 'assignment', 'intake-wizard', 'approval-queue', 'task-checklist'] as const) {
    assert.equal(isComposable(p), true, `${p} should be composable`);
  }
  // KPI/landing/wizard/assignment are BESPOKE (their own sub-editor), not a generic slot list.
  assert.equal(isBespoke('kpi-overview'), true);
  assert.equal(isBespoke('chart-explorer'), false);
});

// ------------------------------------------------------- 4c: source helpers ----

test('datasetIdForMetric derives the dataset from a metric id', () => {
  assert.equal(datasetIdForMetric('ds_9.revenue'), 'ds_9');
  assert.equal(datasetIdForMetric('bare'), undefined);
  assert.equal(datasetIdForMetric(undefined), undefined);
});

test('columnSourceDatasetId resolves a dataset OR a metric-backed source', () => {
  const rt = withDataset(defaultConfigFor('records-table', {}), 'ds_1');
  assert.equal(columnSourceDatasetId(rt), 'ds_1');
  const ce = withMetric(defaultConfigFor('chart-explorer', {}), 'metric', 'ds_2.rev');
  assert.equal(metricIdOf(ce), 'ds_2.rev');
  assert.equal(columnSourceDatasetId(ce), 'ds_2');
});

test('source-choice folds records vs dataset and clears fields on switch', () => {
  let cfg = defaultConfigFor('approval-queue', {});
  assert.equal(sourceIsRecords(cfg), true);
  cfg = withSingleField(cfg, 'titleField', 'x');
  cfg = withDatasetSource(cfg, 'ds_1'); // records → dataset clears the field
  assert.equal((cfg as ApprovalQueueConfig).titleField, '');
  assert.equal(datasetIdOf(cfg), 'ds_1');
  cfg = withSingleField(cfg, 'titleField', 'title');
  cfg = withRecordsSource(cfg); // dataset → records clears again
  assert.equal(sourceIsRecords(cfg), true);
  assert.equal((cfg as ApprovalQueueConfig).titleField, '');
});

test('withEnum sets/clears a closed enum choice, withMetric keeps enum on metric change', () => {
  let cfg = defaultConfigFor('chart-explorer', {});
  cfg = withEnum(cfg, 'chart', 'bar');
  assert.equal((cfg as ChartExplorerConfig).chart, 'bar');
  cfg = withMetric(cfg, 'metric', 'ds_1.rev');
  cfg = withSingleField(cfg, 'timeDimension', 'order_date');
  cfg = withMetric(cfg, 'metric', 'ds_2.rev'); // different dataset → clears field slots
  assert.equal((cfg as ChartExplorerConfig).chart, 'bar', 'enum survives a metric change');
  assert.equal((cfg as ChartExplorerConfig).timeDimension, '');
});

// ------------------------------------------------------- 4c: KPI card reducers ----

test('KPI card reducers add/switch source kinds and keep exactly one source', () => {
  let cards = kpiCards.add([], newMetricCard('Revenue'));
  cards = kpiCards.add(cards, newDatasetCard('Orders'));
  cards = kpiCards.add(cards, newFunctionCard('Ratio', 'fn-x'));
  assert.equal(cardSource(cards[0]), 'metric');
  assert.equal(cardSource(cards[1]), 'dataset');
  assert.equal(cardSource(cards[2]), 'function');
  // count drops the field; switching to sum requires one.
  let c = setCardAgg(cards[1], 'count');
  assert.equal(c.dataset?.field, undefined);
  c = setCardAgg(c, 'sum');
  c = setCardField(c, 'net_amount');
  c = setCardDataset(c, 'ds_1');
  assert.equal(c.dataset?.field, 'net_amount');
  assert.equal(c.dataset?.datasetId, 'ds_1');
  // remove keeps the rest
  cards = kpiCards.remove(cards, 0);
  assert.equal(cards.length, 2);
});

test('ROUND TRIP: a composed kpi-overview (metric + aggregate + function cards) parses + validates', async () => {
  const ds = seedOrders();
  const metricId = seedMetric(ds);

  // one aggregate function the function-card references
  const fn = setAggField(setAggOp(setAggDataset(setFunctionHeader(setFunctionHeader(newAggregateFunction(), 'name', 'Big'), 'description', 'orders over 100'), ds), 'sum'), 'net_amount');
  let state: ComposeState = initialState({ name: 'KPIs', description: 'x', firstDatasetId: ds });
  state = setFunctions(state, [fn]);

  // a kpi-overview tab with three card kinds
  state = setTabPattern(state, 0, 'kpi-overview');
  let cards = kpiCards.add([], { label: 'Revenue', metric: { metricId } });
  cards = kpiCards.add(cards, { label: 'Order count', dataset: { datasetId: ds, agg: 'count' } });
  cards = kpiCards.add(cards, { label: 'Total', dataset: { datasetId: ds, agg: 'sum', field: 'net_amount' } });
  cards = kpiCards.add(cards, { label: 'Computed', function: { functionId: fn.id } });
  state = setTabConfig(state, 0, withKpiCards(state.tabs[0].config as KpiOverviewConfig, cards));

  const { issues } = await acceptedBy(state, appWith([ds], [metricId]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: chart-explorer ----

test('ROUND TRIP: a composed chart-explorer parses + validates', async () => {
  const ds = seedOrders();
  const metricId = seedMetric(ds);
  let state: ComposeState = initialState({ name: 'Chart', description: 'x', firstDatasetId: ds });
  state = setTabPattern(state, 0, 'chart-explorer');
  let cfg = withMetric(state.tabs[0].config, 'metric', metricId);
  cfg = withMultiField(cfg, 'dimensions', ['status']);
  cfg = withSingleField(cfg, 'timeDimension', 'order_id');
  cfg = withEnum(cfg, 'granularity', 'month');
  cfg = withEnum(cfg, 'chart', 'bar');
  state = setTabConfig(state, 0, cfg);
  const { issues } = await acceptedBy(state, appWith([ds], [metricId]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: card-gallery/timeline/calendar ----

test('ROUND TRIP: card-gallery, timeline, calendar compose from selections', async () => {
  const ds = seedOrders();
  let state: ComposeState = initialState({ name: 'Views', description: 'x', firstDatasetId: ds });
  // gallery
  state = setTabPattern(state, 0, 'card-gallery', ds);
  let g = withSingleField(state.tabs[0].config, 'titleField', 'order_id');
  g = withColumns(g, 'fields', ['net_amount']);
  g = withBool(g, 'search', true);
  state = setTabConfig(state, 0, g);
  // timeline
  state = addTab(state, 'timeline', { datasetId: ds });
  let tl = withSingleField(state.tabs[1].config, 'dateField', 'order_id');
  tl = withSingleField(tl, 'titleField', 'status');
  state = setTabConfig(state, 1, tl);
  // calendar
  state = addTab(state, 'calendar', { datasetId: ds });
  let cal = withSingleField(state.tabs[2].config, 'dateField', 'order_id');
  cal = withSingleField(cal, 'titleField', 'status');
  state = setTabConfig(state, 2, cal);

  const { issues } = await acceptedBy(state, appWith([ds]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: landing block list ----

test('landing block reducers add/reorder/remove and edit each block kind', () => {
  let blocks = landingBlocks.add([], newMarkdownBlock('# Hi'));
  blocks = landingBlocks.add(blocks, newKpiBlock());
  blocks = landingBlocks.add(blocks, newTableBlock('ds_1'));
  assert.equal(blocks.length, 3);
  blocks = landingBlocks.move(blocks, 0, 2); // markdown to the end
  assert.equal(blocks[2].kind, 'markdown');
  blocks[2] = setMarkdownContent(blocks[2], '## Bye');
  assert.equal(blocks[2].kind === 'markdown' && blocks[2].content, '## Bye');
  blocks = landingBlocks.remove(blocks, 1);
  assert.equal(blocks.length, 2);
});

test('ROUND TRIP: a composed landing (markdown + kpi + table) parses + validates', async () => {
  const ds = seedOrders();
  const metricId = seedMetric(ds);
  let state: ComposeState = initialState({ name: 'Home app', description: 'x', firstDatasetId: ds });
  state = setTabPattern(state, 0, 'landing');
  let blocks = landingBlocks.add([], newMarkdownBlock('Welcome'));
  blocks = landingBlocks.add(blocks, { kind: 'kpi', cards: [{ label: 'Revenue', metric: { metricId } }] });
  let table = newTableBlock(ds);
  table = setTableBlockColumns(table, [{ field: 'order_id' }, { field: 'net_amount', format: 'currency-eur' }]);
  blocks = landingBlocks.add(blocks, table);
  state = setTabConfig(state, 0, withLandingBlocks(state.tabs[0].config as LandingConfig, blocks));
  const { issues } = await acceptedBy(state, appWith([ds], [metricId]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: intake-wizard steps ----

test('wizard step + field reducers build a multi-step form', () => {
  let steps = wizardSteps.add([], newWizardStep('Contact'));
  steps[0] = setStepTitle(steps[0], 'Your details');
  let field = newFormField();
  field = setFieldAttr(field, 'name', 'full_name');
  field = setFieldAttr(field, 'label', 'Full name');
  field = setFieldAttr(field, 'type', 'text');
  field = setFieldAttr(field, 'required', true);
  steps[0] = { ...steps[0], fields: formFields.add(steps[0].fields, field) };
  assert.equal(steps[0].fields[0].name, 'full_name');
  assert.equal(steps[0].fields[0].required, true);
});

test('ROUND TRIP: a composed intake-wizard parses + validates', async () => {
  let state: ComposeState = initialState({ name: 'Intake', description: 'x' });
  state = setTabPattern(state, 0, 'intake-wizard');
  let step = newWizardStep('Step 1');
  const f1 = setFieldAttr(setFieldAttr(newFormField(), 'name', 'title'), 'label', 'Title');
  step = { ...step, fields: [f1] };
  const cfg = withWizardSteps(state.tabs[0].config as IntakeWizardConfig, [step]);
  state = setTabConfig(state, 0, { ...cfg, submitLabel: 'Submit' });
  const { issues } = await acceptedBy(state, appWith([]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: assignment ----

test('ROUND TRIP: a composed assignment (two datasets) parses + validates', async () => {
  const items = seedOrders();
  const people = seedPeople();
  let state: ComposeState = initialState({ name: 'Assign', description: 'x', firstDatasetId: items });
  state = setTabPattern(state, 0, 'assignment');
  const cfg: AssignmentConfig = {
    source: { datasetId: items },
    itemLabelField: 'order_id',
    assignTo: { datasetId: people, optionLabelField: 'name' },
  };
  state = setTabConfig(state, 0, cfg);
  const { issues } = await acceptedBy(state, appWith([items, people]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: approval-queue + task-checklist ----

test('ROUND TRIP: approval-queue (records) + task-checklist (dataset) parse + validate', async () => {
  const ds = seedOrders();
  let state: ComposeState = initialState({ name: 'Ops', description: 'x', firstDatasetId: ds });
  // approval on the app's own records
  state = setTabPattern(state, 0, 'approval-queue');
  const aq: ApprovalQueueConfig = { source: 'records', titleField: 'title', reasonRequired: true };
  state = setTabConfig(state, 0, aq);
  // task-checklist on a granted dataset
  state = addTab(state, 'task-checklist', {});
  let tc = withDatasetSource(state.tabs[1].config, ds);
  tc = withSingleField(tc, 'titleField', 'order_id');
  tc = withSingleField(tc, 'assigneeField', 'status');
  state = setTabConfig(state, 1, tc as TaskChecklistConfig);
  const { issues } = await acceptedBy(state, appWith([ds]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

// ------------------------------------------------------- 4c: function editor ----

test('function reducers build a valid functions[] (aggregate + expression)', () => {
  let fns = appFunctions.add([], newAggregateFunction());
  fns[0] = setFunctionHeader(fns[0], 'name', 'Total');
  fns[0] = setFunctionHeader(fns[0], 'description', 'sum of amounts');
  fns[0] = setAggDataset(fns[0], 'ds_1');
  fns[0] = setAggOp(fns[0], 'sum');
  fns[0] = setAggField(fns[0], 'net_amount');
  assert.equal(fns[0].kind, 'aggregate');
  assert.equal((fns[0] as { field?: string }).field, 'net_amount');

  let e = newExpressionFunction();
  e = setFunctionHeader(e, 'name', 'Half');
  e = setFunctionHeader(e, 'description', 'half the total');
  e = setExpr(e, `fn.${fns[0].id} / 2`);
  fns = appFunctions.add(fns, e);
  // toggling kind keeps id/name/description
  const toggled = setFunctionKind(fns[0], 'expression');
  assert.equal(toggled.kind, 'expression');
  assert.equal(toggled.name, 'Total');
});

test('ROUND TRIP: an aggregate + expression functions[] parses + validates', async () => {
  const ds = seedOrders();
  let total = setFunctionHeader(setFunctionHeader(newAggregateFunction(), 'name', 'Total'), 'description', 'sum');
  total = setAggField(setAggOp(setAggDataset(total, ds), 'sum'), 'net_amount');
  let half = setFunctionHeader(setFunctionHeader(newExpressionFunction(), 'name', 'Half'), 'description', 'half');
  half = setExpr(half, `fn.${total.id} / 2`);

  let state: ComposeState = initialState({ name: 'Fns', description: 'x', firstDatasetId: ds });
  state = setFunctions(state, [total, half]);
  // a kpi card that shows the expression's value
  state = setTabPattern(state, 0, 'kpi-overview');
  state = setTabConfig(state, 0, withKpiCards(state.tabs[0].config as KpiOverviewConfig, [{ label: 'Half', function: { functionId: half.id } }]));

  const { issues } = await acceptedBy(state, appWith([ds]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

test('a function-editor cycle / bad expr is surfaced as a function-scoped issue', async () => {
  const ds = seedOrders();
  // an expression referencing an UNDECLARED function → validate issue on functions[0]
  let e = setFunctionHeader(setFunctionHeader(newExpressionFunction(), 'name', 'X'), 'description', 'y');
  e = setExpr(e, 'fn.nope + 1');
  let state: ComposeState = initialState({ name: 'Fns', description: 'x', firstDatasetId: ds });
  // a valid records-table tab so the ONLY issue is the function's unknown ref.
  state = setTabConfig(state, 0, withColumns(state.tabs[0].config, 'columns', ['order_id']));
  state = setFunctions(state, [e]);
  const parsed = parseAppSpec(composeSpec(state));
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify((parsed as { issues: SpecIssue[] }).issues));
  const { issues } = await validateAppSpec(appWith([ds]), (parsed as { ok: true; spec: AppSpec }).spec, amir);
  assert.ok(issues.length > 0, 'unknown fn ref should be rejected');
  const located = locateIssues(issues, []);
  assert.ok(issuesForFunction(located, 0).length > 0, 'the issue is attributed to functions[0]');
});

// ------------------------------------------------------- 4c: custom block body ----

test('setTabCustom composes a sandboxed custom body; clearTabCustom restores the pattern', () => {
  let state: ComposeState = initialState({ name: 'Custom', description: 'x' });
  state = setTabCustom(state, 0, { kind: 'custom', html: '<h1>Hi</h1>', css: 'h1{color:red}', js: 'console.log(1)' });
  const spec = composeSpec(state);
  assert.equal(spec.tabs[0].body.kind, 'custom');
  assert.equal(spec.tabs[0].body.kind === 'custom' && spec.tabs[0].body.html, '<h1>Hi</h1>');
  // parse accepts it
  const parsed = parseAppSpec(spec);
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify((parsed as { issues: SpecIssue[] }).issues));
  // clear → back to the pattern body
  state = clearTabCustom(state, 0);
  assert.equal(composeSpec(state).tabs[0].body.kind, 'pattern');
});

test('ROUND TRIP: a custom-block tab with injected read-only data parses + validates', async () => {
  const ds = seedOrders();
  let state: ComposeState = initialState({ name: 'Widget', description: 'x', firstDatasetId: ds });
  state = setTabCustom(state, 0, {
    kind: 'custom',
    html: '<div id="app"></div>',
    js: 'document.getElementById("app").textContent = JSON.stringify(window.__DATA__);',
    data: { datasetId: ds, as: 'orders' },
  });
  const { issues } = await acceptedBy(state, appWith([ds]));
  assert.deepEqual(issues, [], `expected clean, got ${JSON.stringify(issues)}`);
});

test('stateFromSpec preserves a custom-block tab + functions on round-trip', () => {
  let state: ComposeState = initialState({ name: 'App', description: 'x' });
  state = setTabCustom(state, 0, { kind: 'custom', html: '<p>x</p>' });
  const fn = setAggField(setAggOp(setAggDataset(setFunctionHeader(setFunctionHeader(newAggregateFunction(), 'name', 'T'), 'description', 'd'), 'ds_1'), 'sum'), 'v');
  state = setFunctions(state, [fn]);
  const round = stateFromSpec(composeSpec(state));
  assert.equal(round.tabs[0].custom?.html, '<p>x</p>');
  assert.equal(round.functions.length, 1);
});

// ------------------------------------------------------- 4c: theme + issue paths ----

test('setThemeCss sets and clears the app theme', () => {
  let state: ComposeState = initialState({ name: 'A', description: 'b' });
  state = setThemeCss(state, '.x{color:blue}');
  assert.equal(composeSpec(state).theme?.css, '.x{color:blue}');
  state = setThemeCss(state, '   ');
  assert.equal('theme' in composeSpec(state), false);
});

// --------------------------------------- 4c: React #31 column-object regression ----
// The dataset-detail API returns column DOCS ({name, description}[]) for BOTH `columns` and
// `goldColumns` (goldOutputColumns → ColumnDoc[]). The composer renders these as JSX children, so
// they MUST be reduced to string names — a raw {name, description} object as a child is React #31,
// which crashed the Build stage on MOUNT for a fresh declarative app with a promoted Gold dataset.

test('extractColumnNames reduces {name,description} column docs to string names', () => {
  // goldColumns / columns as the API actually returns them: objects, not strings.
  const goldDocs = [
    { name: 'order_id', description: 'PK' },
    { name: 'net_amount', description: 'Money' },
  ];
  const names = extractColumnNames(goldDocs);
  assert.deepEqual(names, ['order_id', 'net_amount']);
  // every element is a plain string (renderable as a JSX child) — never an object.
  for (const n of names) assert.equal(typeof n, 'string');
});

test('extractColumnNames tolerates strings, blanks, malformed entries and non-arrays', () => {
  assert.deepEqual(extractColumnNames(['a', 'b']), ['a', 'b']); // already-string column lists
  assert.deepEqual(extractColumnNames([{ name: 'x' }, { name: '' }, { name: 42 }, {}, null, 'y']), ['x', 'y']);
  assert.deepEqual(extractColumnNames(undefined), []);
  assert.deepEqual(extractColumnNames({}), []);
});

test('targetForPath maps function + custom-body + theme paths', () => {
  assert.deepEqual(targetForPath('functions[2].expr'), { scope: 'function', fnIndex: 2 });
  assert.deepEqual(targetForPath('functions[0].source.datasetId'), { scope: 'function', fnIndex: 0 });
  assert.deepEqual(targetForPath('tabs[1].body.html'), { scope: 'tab', tabIndex: 1, slot: 'html' });
  assert.deepEqual(targetForPath('tabs[0].body.js'), { scope: 'tab', tabIndex: 0, slot: 'js' });
  assert.deepEqual(targetForPath('theme.css'), { scope: 'app', field: 'theme' });
});

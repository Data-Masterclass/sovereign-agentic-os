/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * patterns.test — the cookbook REGISTRY contract. Pins: all 18 grammar ids present + categorised;
 * exactly the 4 flagship patterns are flagged implemented; the registry stays in lockstep with the
 * enum; every entry's `summarize` returns a non-empty plain-language line; the two write patterns
 * are 'interactive'; and `parsePatternConfig` accepts/refuses configs correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PATTERNS,
  PATTERN_IDS,
  IMPLEMENTED_PATTERNS,
  isImplementedPattern,
  parsePatternConfig,
  summarizePattern,
  type PatternConfig,
  type PatternId,
} from './patterns.ts';
import type { Ctx } from './schema.ts';

const EXPECTED_IDS = [
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
  'form',
  'intake-wizard',
  'editable-grid',
  'kanban-workflow',
  'approval-queue',
  'assignment',
  'task-checklist',
  'action-detail',
];

test('the enum contains all expected pattern ids and nothing else', () => {
  assert.deepEqual([...PATTERN_IDS].sort(), [...EXPECTED_IDS].sort());
  assert.equal(PATTERN_IDS.length, 18);
});

test('every enum id has a registry entry whose id matches its key (in lockstep)', () => {
  for (const id of PATTERN_IDS) {
    assert.ok(PATTERNS[id], `missing registry entry for ${id}`);
    assert.equal(PATTERNS[id].id, id);
  }
});

test('the 11 view patterns + 5 interactive patterns are flagged implemented (3.5c)', () => {
  const implemented = PATTERN_IDS.filter((id) => PATTERNS[id].implemented).sort();
  assert.deepEqual(implemented, [...IMPLEMENTED_PATTERNS].sort());
  assert.deepEqual(implemented, [
    'approval-queue',
    'assignment',
    'calendar',
    'card-gallery',
    'chart-explorer',
    'detail',
    'form',
    'intake-wizard',
    'kpi-overview',
    'landing',
    'master-detail',
    'records-table',
    'status-board',
    'task-checklist',
    'timeline',
  ]);
  for (const id of IMPLEMENTED_PATTERNS) assert.ok(isImplementedPattern(id));
  // A still-deferred interactive id is NOT implemented yet.
  assert.equal(isImplementedPattern('editable-grid' as PatternId), false);
  assert.equal(isImplementedPattern('kanban-workflow' as PatternId), false);
  assert.equal(isImplementedPattern('action-detail' as PatternId), false);
});

test('the write patterns are interactive; the flagship viewers are views', () => {
  assert.equal(PATTERNS['form'].category, 'interactive');
  assert.equal(PATTERNS['intake-wizard'].category, 'interactive');
  assert.equal(PATTERNS['assignment'].category, 'interactive');
  assert.equal(PATTERNS['approval-queue'].category, 'interactive');
  assert.equal(PATTERNS['task-checklist'].category, 'interactive');
  assert.equal(PATTERNS['records-table'].category, 'view');
  assert.equal(PATTERNS['detail'].category, 'view');
  assert.equal(PATTERNS['status-board'].category, 'view');
});

test('the 3 STILL-deferred interactive ids are present, interactive, and not implemented', () => {
  for (const id of ['editable-grid', 'kanban-workflow', 'action-detail'] as PatternId[]) {
    assert.equal(PATTERNS[id].category, 'interactive');
    assert.equal(PATTERNS[id].implemented, false);
  }
});

test('every category is a valid value and every entry has a label + description', () => {
  for (const id of PATTERN_IDS) {
    const d = PATTERNS[id];
    assert.ok(d.category === 'view' || d.category === 'interactive');
    assert.ok(d.label.length > 0);
    assert.ok(d.description.length > 0);
  }
});

test('summarize returns a non-empty plain-language line for a coming-soon (interactive) pattern', () => {
  const s = summarizePattern('kanban-workflow', {} as PatternConfig);
  assert.ok(s.length > 0);
  assert.match(s, /coming soon/i);
});

test('summarize for records-table names the dataset and columns', () => {
  const cfg: PatternConfig = { source: { datasetId: 'ds_x' }, columns: [{ field: 'a' }, { field: 'b' }] } as PatternConfig;
  const s = summarizePattern('records-table', cfg);
  assert.match(s, /ds_x/);
  assert.match(s, /a, b/);
});

test('parsePatternConfig accepts a valid records-table config and refuses a non-object', () => {
  const ok: Ctx = { issues: [] };
  const cfg = parsePatternConfig(ok, 'records-table', { source: { datasetId: 'ds' }, columns: [{ field: 'a' }] }, 'c');
  assert.deepEqual(ok.issues, []);
  assert.ok(cfg);

  const bad: Ctx = { issues: [] };
  const none = parsePatternConfig(bad, 'records-table', 42, 'c');
  assert.equal(none, undefined);
  assert.ok(bad.issues.length > 0);
});

test('parsePatternConfig for a coming-soon (deferred interactive) pattern accepts any object (opaque)', () => {
  const ctx: Ctx = { issues: [] };
  const cfg = parsePatternConfig(ctx, 'kanban-workflow', { whatever: [1, 2, 3] }, 'c');
  assert.deepEqual(ctx.issues, []);
  assert.ok(cfg);
});

// ---------------------------------------------------------------- 3.5b VIEW patterns ----

/** Parse a config cleanly and return it; asserts no issues. */
function ok(pattern: PatternId, config: Record<string, unknown>): PatternConfig {
  const ctx: Ctx = { issues: [] };
  const cfg = parsePatternConfig(ctx, pattern, config, 'c');
  assert.deepEqual(ctx.issues, [], `expected clean parse, got: ${JSON.stringify(ctx.issues)}`);
  assert.ok(cfg);
  return cfg!;
}
/** Parse a bad config; asserts it fails with at least one typed issue. */
function bad(pattern: PatternId, config: unknown): void {
  const ctx: Ctx = { issues: [] };
  parsePatternConfig(ctx, pattern, config as Record<string, unknown>, 'c');
  assert.ok(ctx.issues.length > 0, 'expected at least one issue');
}

test('master-detail parses source/keyField/listColumns/detailFields; refuses missing keyField', () => {
  ok('master-detail', {
    source: { datasetId: 'ds' },
    keyField: 'id',
    listColumns: [{ field: 'name' }],
    detailFields: [{ field: 'name' }, { field: 'amount', format: 'currency-eur' }],
  });
  const s = summarizePattern('master-detail', ok('master-detail', {
    source: { datasetId: 'ds_x' }, keyField: 'id', listColumns: [{ field: 'a' }], detailFields: [{ field: 'a' }],
  }));
  assert.match(s, /ds_x/);
  bad('master-detail', { source: { datasetId: 'ds' }, listColumns: [{ field: 'a' }], detailFields: [{ field: 'a' }] });
});

test('kpi-overview parses metric AND dataset-aggregate cards; a card needs exactly one source', () => {
  ok('kpi-overview', {
    cards: [
      { label: 'Revenue', metric: { metricId: 'Orders.revenue' } },
      { label: 'Orders', dataset: { datasetId: 'ds', agg: 'count' } },
      { label: 'Avg', dataset: { datasetId: 'ds', agg: 'avg', field: 'amount' } },
    ],
  });
  // a card with NO source → issue
  bad('kpi-overview', { cards: [{ label: 'x' }] });
  // a card with BOTH sources → issue
  bad('kpi-overview', { cards: [{ label: 'x', metric: { metricId: 'M' }, dataset: { datasetId: 'ds', agg: 'count' } }] });
  // sum without a field → issue
  bad('kpi-overview', { cards: [{ label: 'x', dataset: { datasetId: 'ds', agg: 'sum' } }] });
});

test('chart-explorer parses metric + chart kind; refuses a bad chart kind', () => {
  const cfg = ok('chart-explorer', { metric: { metricId: 'Orders.revenue' }, chart: 'line', timeDimension: 'Orders.createdAt', granularity: 'month' });
  assert.match(summarizePattern('chart-explorer', cfg), /Orders\.revenue/);
  bad('chart-explorer', { metric: { metricId: 'M' }, chart: 'pie' });
  bad('chart-explorer', { chart: 'line' }); // missing metric
});

test('card-gallery parses title/subtitle/fields/search; refuses missing titleField', () => {
  ok('card-gallery', { source: { datasetId: 'ds' }, titleField: 'name', subtitleField: 'role', fields: [{ field: 'email' }], search: true });
  bad('card-gallery', { source: { datasetId: 'ds' }, fields: [{ field: 'email' }] });
});

test('timeline parses date/title/description; refuses missing dateField', () => {
  ok('timeline', { source: { datasetId: 'ds' }, dateField: 'created', titleField: 'name', descriptionField: 'note' });
  bad('timeline', { source: { datasetId: 'ds' }, titleField: 'name' });
});

test('calendar parses date/title; refuses missing titleField', () => {
  ok('calendar', { source: { datasetId: 'ds' }, dateField: 'created', titleField: 'name' });
  bad('calendar', { source: { datasetId: 'ds' }, dateField: 'created' });
});

test('landing parses markdown/kpi/table blocks; refuses an unknown block kind', () => {
  const cfg = ok('landing', {
    blocks: [
      { kind: 'markdown', content: '# Hello' },
      { kind: 'kpi', cards: [{ label: 'R', metric: { metricId: 'Orders.revenue' } }] },
      { kind: 'table', source: { datasetId: 'ds' }, columns: [{ field: 'name' }] },
    ],
  });
  assert.match(summarizePattern('landing', cfg), /3 blocks/);
  bad('landing', { blocks: [{ kind: 'nope' }] });
  bad('landing', { blocks: [] }); // empty blocks array → issue
});

// ------------------------------------------------- 3.5c INTERACTIVE (append) patterns ----

test('form parses target/fields/submitLabel; refuses a missing target and empty fields', () => {
  const cfg = ok('form', {
    target: 'records',
    fields: [{ name: 'title', label: 'Title', type: 'text', required: true }, { name: 'amount', label: 'Amount', type: 'number' }],
    submitLabel: 'Create',
  });
  assert.match(summarizePattern('form', cfg), /2 fields/);
  bad('form', { fields: [{ name: 'x', label: 'X', type: 'text' }] }); // missing target
  bad('form', { target: 'records', fields: [] }); // empty fields → issue
  bad('form', { target: 'records', fields: [{ name: 'x', label: 'X', type: 'nope' }] }); // bad field type
});

test('assignment parses source/itemLabelField/assignTo/extraFields; refuses missing assignTo', () => {
  const cfg = ok('assignment', {
    source: { datasetId: 'ds_cases' },
    itemLabelField: 'case_name',
    assignTo: { datasetId: 'ds_employees', optionLabelField: 'full_name' },
    extraFields: [{ name: 'priority', label: 'Priority', type: 'text' }],
  });
  assert.match(summarizePattern('assignment', cfg), /ds_cases/);
  assert.match(summarizePattern('assignment', cfg), /ds_employees/);
  bad('assignment', { source: { datasetId: 'ds' }, itemLabelField: 'n' }); // missing assignTo
  bad('assignment', { source: { datasetId: 'ds' }, itemLabelField: 'n', assignTo: { datasetId: 'e' } }); // missing optionLabelField
});

test('approval-queue parses a "records" source AND a dataset source; refuses a bad source', () => {
  const rec = ok('approval-queue', { source: 'records', titleField: 'title', reasonRequired: true });
  assert.match(summarizePattern('approval-queue', rec), /own records/);
  const ds = ok('approval-queue', { source: { datasetId: 'ds_req' }, titleField: 'name', subtitleFields: ['team', 'when'], decisionField: 'state' });
  assert.match(summarizePattern('approval-queue', ds), /ds_req/);
  bad('approval-queue', { source: 42, titleField: 'x' }); // source neither string nor object
  bad('approval-queue', { source: 'records' }); // missing titleField
});

test('task-checklist parses a "records" source AND a dataset source; refuses missing titleField', () => {
  const rec = ok('task-checklist', { source: 'records', titleField: 'task' });
  assert.match(summarizePattern('task-checklist', rec), /own records/);
  const ds = ok('task-checklist', { source: { datasetId: 'ds_tasks' }, titleField: 'name', assigneeField: 'owner' });
  assert.match(summarizePattern('task-checklist', ds), /ds_tasks/);
  bad('task-checklist', { source: 'records' }); // missing titleField
  bad('task-checklist', { source: { foo: 'bar' }, titleField: 't' }); // dataset source without datasetId
});

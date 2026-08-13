/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * validate.test — the author-time SEMANTIC gate against the REAL stores (v2 tabs·patterns). Seeds
 * datasets via the same public API `lib/data/store.test.ts` uses, then asserts each invariant from
 * DESIGN.md over pattern configs: missing dataset → issue, ungranted → issue, Personal → warning,
 * unknown column → issue LISTING the real columns, custom-block injected data checked, duplicate
 * tab ids → issue, and a good spec → clean. Store peeks are unscoped, so the checks don't depend
 * on the caller's identity.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, setDocs, defineMeasure, transition, type Principal } from '../../data/store.ts';
import { validateAppSpec, type SpecWarning } from './validate.ts';
import { parseAppSpec, type AppSpec, type SpecIssue } from './schema.ts';
import type { App, AppEpic } from '../apps.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };

beforeEach(() => __resetStore());

/** A minimal App the validator reads — it touches `grants.data`, `grants.metrics` and `epics`. */
function app(dataIds: string[], opts?: { metrics?: string[]; epics?: AppEpic[] }): App {
  return {
    grants: {
      data: dataIds.map((id) => ({ id })),
      metrics: (opts?.metrics ?? []).map((id) => ({ id })),
    },
    epics: opts?.epics ?? [],
  } as unknown as App;
}

/** Seed a metric (`datasetId.revenue`) on a dataset and return the metric id. */
function seedMetric(datasetId: string, name = 'revenue'): string {
  defineMeasure(datasetId, amir, { name, type: 'sum', sql: 'net_amount' });
  return `${datasetId}.${name}`;
}

/** Build a Gold "Orders" dataset with documented columns; returns its id. */
function seedOrders(promote = true): string {
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
  if (promote) transition(d.id, amir, 'promote');
  return d.id;
}

function parse(input: unknown): AppSpec {
  const r = parseAppSpec(input);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify((r as { issues: SpecIssue[] }).issues));
  return (r as { ok: true; spec: AppSpec }).spec;
}

function tableSpec(datasetId: string, fields: string[]): AppSpec {
  return parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: { source: { datasetId }, columns: fields.map((f) => ({ field: f })) },
        },
      },
    ],
  });
}

function hasIssue(issues: SpecIssue[], substr: RegExp): SpecIssue {
  const found = issues.find((i) => substr.test(i.reason));
  assert.ok(found, `expected an issue matching ${substr}, got: ${JSON.stringify(issues)}`);
  return found!;
}
function hasWarning(warnings: SpecWarning[], substr: RegExp): SpecWarning {
  const found = warnings.find((w) => substr.test(w.reason));
  assert.ok(found, `expected a warning matching ${substr}, got: ${JSON.stringify(warnings)}`);
  return found!;
}

test('a good records-table spec (granted, real columns) has NO issues and NO warnings', async () => {
  const id = seedOrders();
  const { issues, warnings } = await validateAppSpec(app([id]), tableSpec(id, ['order_id', 'net_amount']), amir);
  assert.deepEqual(issues, []);
  assert.deepEqual(warnings, []);
});

test('DEFENSE-IN-DEPTH: a bound dataset the AUTHOR cannot view is flagged (M2), and the owner passes', async () => {
  // A PERSONAL (unpromoted) dataset is owner-only. A different-domain user who is not its owner
  // cannot view it — binding it must surface a "not entitled" issue (defense-in-depth only-DENY).
  const id = seedOrders(false); // personal, owner-only
  const outsider: Principal = { id: 'bara', domains: ['ops'], role: 'builder' };
  const spec = tableSpec(id, ['order_id']);
  // Author who OWNS it → no entitlement issue (the grant/column checks are separately satisfied).
  assert.equal(
    (await validateAppSpec(app([id]), spec, amir)).issues.some((i) => /not entitled/.test(i.reason)),
    false,
  );
  // Author who can't view it → a blocking "not entitled" issue on grants.data.
  const denied = hasIssue((await validateAppSpec(app([id]), spec, outsider)).issues, /not entitled/);
  assert.equal(denied.path, 'grants.data');
});

test('a MISSING dataset is a blocking issue with a restore fix', async () => {
  const { issues } = await validateAppSpec(app(['ds_gone']), tableSpec('ds_gone', ['order_id']), amir);
  const i = hasIssue(issues, /does not exist/);
  assert.match(i.reason, /ds_gone/);
  assert.match(i.fix, /restore/);
});

test('an UNGRANTED (but existing) dataset is a blocking issue with a grant fix', async () => {
  const id = seedOrders();
  const { issues } = await validateAppSpec(app([]), tableSpec(id, ['order_id']), amir);
  const i = hasIssue(issues, /is not granted/);
  assert.match(i.fix, /grant it in Context/);
});

test('a PERSONAL (owner-only) dataset is a WARNING, not a block', async () => {
  const id = seedOrders(false);
  const { issues, warnings } = await validateAppSpec(app([id]), tableSpec(id, ['order_id']), amir);
  assert.equal(issues.length, 0, 'personal is allowed (warned), not blocked');
  const w = hasWarning(warnings, /Only you can read this dataset/);
  assert.match(w.fix, /promote it to Domain/);
});

test('an UNKNOWN column is a blocking issue that LISTS the real columns', async () => {
  const id = seedOrders();
  const { issues } = await validateAppSpec(app([id]), tableSpec(id, ['order_id', 'not_a_column']), amir);
  const i = hasIssue(issues, /column not_a_column not in dataset/);
  assert.match(i.fix, /order_id/);
  assert.match(i.fix, /net_amount/);
  assert.match(i.fix, /status/);
});

test('a records-table filter field is column-checked too', async () => {
  const id = seedOrders();
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: { source: { datasetId: id }, columns: [{ field: 'order_id' }], filters: [{ field: 'ghost', control: 'select' }] },
        },
      },
    ],
  });
  const { issues } = await validateAppSpec(app([id]), spec, amir);
  hasIssue(issues, /column ghost not in dataset/);
});

test('detail pattern keyField + fields are existence-checked against real columns', async () => {
  const id = seedOrders();
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Detail',
        body: {
          kind: 'pattern',
          pattern: 'detail',
          config: { source: { datasetId: id }, keyField: 'nope', fields: [{ field: 'net_amount' }] },
        },
      },
    ],
  });
  const { issues } = await validateAppSpec(app([id]), spec, amir);
  hasIssue(issues, /column nope not in dataset/);
});

test('status-board statusField + titleField + subtitleFields are column-checked', async () => {
  const id = seedOrders();
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Board',
        body: {
          kind: 'pattern',
          pattern: 'status-board',
          config: { source: { datasetId: id }, statusField: 'status', titleField: 'order_id', subtitleFields: ['ghost_sub'] },
        },
      },
    ],
  });
  const { issues } = await validateAppSpec(app([id]), spec, amir);
  hasIssue(issues, /column ghost_sub not in dataset/);
});

test('a custom block’s injected data must reference a granted, existing dataset', async () => {
  const id = seedOrders();
  const mk = (datasetId: string) =>
    parse({
      version: 2,
      name: 'App',
      description: 'x',
      tabs: [{ id: 't1', label: 'Widget', body: { kind: 'custom', html: '<h1>hi</h1>', data: { datasetId } } }],
    });

  // ungranted → issue
  hasIssue((await validateAppSpec(app([]), mk(id), amir)).issues, /is not granted/);
  // missing → issue
  hasIssue((await validateAppSpec(app(['ds_gone']), mk('ds_gone'), amir)).issues, /does not exist/);
  // granted + existing → clean
  assert.deepEqual((await validateAppSpec(app([id]), mk(id), amir)).issues, []);
});

test('an intake-wizard writes to app records — no dataset check, no false issues', async () => {
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      {
        id: 't1',
        label: 'Intake',
        body: {
          kind: 'pattern',
          pattern: 'intake-wizard',
          config: { target: 'records', steps: [{ title: 'A', fields: [{ name: 'note', label: 'Note', type: 'text' }] }], submitLabel: 'Save' },
        },
      },
    ],
  });
  const { issues, warnings } = await validateAppSpec(app([]), spec, amir);
  assert.deepEqual(issues, []);
  assert.deepEqual(warnings, []);
});

test('a coming-soon (deferred interactive) pattern (opaque config) validates clean', async () => {
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [{ id: 't1', label: 'Board', body: { kind: 'pattern', pattern: 'kanban-workflow', config: { anything: true } } }],
  });
  const { issues } = await validateAppSpec(app([]), spec, amir);
  assert.deepEqual(issues, []);
});

test('duplicate tab ids are a blocking issue', async () => {
  const id = seedOrders();
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      { id: 'dup', label: 'A', body: { kind: 'custom', html: '<b>a</b>' } },
      { id: 'dup', label: 'B', body: { kind: 'custom', html: '<b>b</b>' } },
    ],
  });
  const { issues } = await validateAppSpec(app([id]), spec, amir);
  hasIssue(issues, /duplicate tab id/);
});

// ---------------------------------------------------------------- 3.5b VIEW patterns ----

function oneTab(id: string, pattern: string, config: unknown): AppSpec {
  return parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [{ id: 't1', label: 'T', body: { kind: 'pattern', pattern, config } }],
  });
}

test('master-detail keyField + listColumns + detailFields are column-checked', async () => {
  const id = seedOrders();
  const spec = oneTab(id, 'master-detail', {
    source: { datasetId: id },
    keyField: 'order_id',
    listColumns: [{ field: 'order_id' }],
    detailFields: [{ field: 'ghost_detail' }],
  });
  const { issues } = await validateAppSpec(app([id]), spec, amir);
  hasIssue(issues, /column ghost_detail not in dataset/);
});

test('kpi-overview: a dataset-aggregate card is column-checked; a metric card is metric-checked', async () => {
  const id = seedOrders();
  const metricId = seedMetric(id);
  // dataset card with a ghost field → issue
  const badField = oneTab(id, 'kpi-overview', {
    cards: [{ label: 'Sum', dataset: { datasetId: id, agg: 'sum', field: 'ghost_field' } }],
  });
  hasIssue((await validateAppSpec(app([id], { metrics: [metricId] }), badField, amir)).issues, /column ghost_field not in dataset/);

  // metric card referencing a granted, existing metric → clean
  const good = oneTab(id, 'kpi-overview', {
    cards: [
      { label: 'Revenue', metric: { metricId } },
      { label: 'Orders', dataset: { datasetId: id, agg: 'count' } },
    ],
  });
  assert.deepEqual((await validateAppSpec(app([id], { metrics: [metricId] }), good, amir)).issues, []);
});

test('chart-explorer: a missing metric is a blocking issue, an ungranted one too', async () => {
  const id = seedOrders();
  const metricId = seedMetric(id);
  // missing metric (dataset exists but no such measure)
  const missing = oneTab(id, 'chart-explorer', { metric: { metricId: `${id}.nope` }, chart: 'line' });
  hasIssue((await validateAppSpec(app([id], { metrics: [`${id}.nope`] }), missing, amir)).issues, /does not exist/);
  // existing but not granted
  const ungranted = oneTab(id, 'chart-explorer', { metric: { metricId }, chart: 'bar' });
  hasIssue((await validateAppSpec(app([id]), ungranted, amir)).issues, /is not granted/);
  // existing + granted → clean
  const good = oneTab(id, 'chart-explorer', { metric: { metricId }, chart: 'area' });
  assert.deepEqual((await validateAppSpec(app([id], { metrics: [metricId] }), good, amir)).issues, []);
});

test('card-gallery + timeline + calendar column-check their fields', async () => {
  const id = seedOrders();
  hasIssue(
    (await validateAppSpec(app([id]), oneTab(id, 'card-gallery', { source: { datasetId: id }, titleField: 'ghost_title' }), amir)).issues,
    /column ghost_title not in dataset/,
  );
  hasIssue(
    (await validateAppSpec(app([id]), oneTab(id, 'timeline', { source: { datasetId: id }, dateField: 'ghost_date', titleField: 'order_id' }), amir)).issues,
    /column ghost_date not in dataset/,
  );
  hasIssue(
    (await validateAppSpec(app([id]), oneTab(id, 'calendar', { source: { datasetId: id }, dateField: 'status', titleField: 'ghost_cal' }), amir)).issues,
    /column ghost_cal not in dataset/,
  );
});

test('landing validates its table block dataset + kpi cards; markdown references nothing', async () => {
  const id = seedOrders();
  const metricId = seedMetric(id);
  const spec = oneTab(id, 'landing', {
    blocks: [
      { kind: 'markdown', content: '# Home' },
      { kind: 'kpi', cards: [{ label: 'R', metric: { metricId } }] },
      { kind: 'table', source: { datasetId: id }, columns: [{ field: 'ghost_col' }] },
    ],
  });
  hasIssue((await validateAppSpec(app([id], { metrics: [metricId] }), spec, amir)).issues, /column ghost_col not in dataset/);
});

// ---------------------------------------------------------------- tab ↔ story links ----

const epics: AppEpic[] = [
  {
    id: 'ep1',
    title: 'Orders',
    description: '',
    requirements: { technical: '', ux: '', governance: '' },
    stories: [
      { id: 's1', title: 'List', asA: '', iWant: '', soThat: '', acceptance: '' },
      { id: 's2', title: 'Detail', asA: '', iWant: '', soThat: '', acceptance: '' },
    ],
  },
];

function tabWithStories(refs: { epicId: string; storyId: string }[]): AppSpec {
  return parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [{ id: 't1', label: 'T', stories: refs, body: { kind: 'custom', html: '<b>x</b>' } }],
  });
}

test('a valid tab→story ref (existing epic + story) is clean', async () => {
  const spec = tabWithStories([{ epicId: 'ep1', storyId: 's1' }]);
  const { issues } = await validateAppSpec(app([], { epics }), spec, amir);
  assert.deepEqual(issues, []);
});

test('an unknown epic ref is a blocking issue', async () => {
  const spec = tabWithStories([{ epicId: 'nope', storyId: 's1' }]);
  hasIssue((await validateAppSpec(app([], { epics }), spec, amir)).issues, /epic nope is not a designed epic/);
});

test('a story not under its named epic is a blocking issue', async () => {
  const spec = tabWithStories([{ epicId: 'ep1', storyId: 's_ghost' }]);
  hasIssue((await validateAppSpec(app([], { epics }), spec, amir)).issues, /story s_ghost is not under epic ep1/);
});

test('many-to-many is allowed: two tabs may serve the same story, one tab many stories', async () => {
  const spec = parse({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [
      { id: 'a', label: 'A', stories: [{ epicId: 'ep1', storyId: 's1' }, { epicId: 'ep1', storyId: 's2' }], body: { kind: 'custom', html: '<b>a</b>' } },
      { id: 'b', label: 'B', stories: [{ epicId: 'ep1', storyId: 's1' }], body: { kind: 'custom', html: '<b>b</b>' } },
    ],
  });
  const { issues } = await validateAppSpec(app([], { epics }), spec, amir);
  assert.deepEqual(issues, []);
});

// -------------------------------------------------- 3.5c INTERACTIVE (append) patterns ----

/** Build a Gold "Employees" dataset with documented columns; returns its id. */
function seedEmployees(promote = true): string {
  const d = createDataset(amir, { name: 'Employees' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/emp.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_emp.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/emp.sql' });
  setDocs(d.id, amir, { columns: [{ name: 'employee_id', description: 'PK' }, { name: 'full_name', description: 'Name' }] });
  if (promote) transition(d.id, amir, 'promote');
  return d.id;
}

test('form writes to records — no dataset source, so a granted-free spec is CLEAN', async () => {
  const spec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'New', body: { kind: 'pattern', pattern: 'form', config: { target: 'records', fields: [{ name: 'title', label: 'T', type: 'text' }] } } }],
  });
  const { issues, warnings } = await validateAppSpec(app([]), spec, amir);
  assert.deepEqual(issues, []);
  assert.deepEqual(warnings, []);
});

test('assignment validates BOTH datasets (granted + label columns exist)', async () => {
  const cases = seedOrders();
  const emps = seedEmployees();
  const good = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'Assign', body: { kind: 'pattern', pattern: 'assignment', config: {
      source: { datasetId: cases }, itemLabelField: 'order_id',
      assignTo: { datasetId: emps, optionLabelField: 'full_name' },
    } } }],
  });
  assert.deepEqual((await validateAppSpec(app([cases, emps]), good, amir)).issues, []);

  // assignTo NOT granted → issue
  hasIssue((await validateAppSpec(app([cases]), good, amir)).issues, /is not granted/);

  // a bad label column on assignTo → issue listing the real columns
  const badLabel = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'Assign', body: { kind: 'pattern', pattern: 'assignment', config: {
      source: { datasetId: cases }, itemLabelField: 'order_id',
      assignTo: { datasetId: emps, optionLabelField: 'ghost_col' },
    } } }],
  });
  const i = hasIssue((await validateAppSpec(app([cases, emps]), badLabel, amir)).issues, /column ghost_col not in dataset/);
  assert.match(i.fix, /full_name/);
});

test('approval-queue source:"records" needs no dataset; a dataset source is column-checked', async () => {
  const recSpec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'Q', body: { kind: 'pattern', pattern: 'approval-queue', config: { source: 'records', titleField: 'title' } } }],
  });
  assert.deepEqual((await validateAppSpec(app([]), recSpec, amir)).issues, []);

  const id = seedOrders();
  const dsSpec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'Q', body: { kind: 'pattern', pattern: 'approval-queue', config: { source: { datasetId: id }, titleField: 'ghost_title' } } }],
  });
  hasIssue((await validateAppSpec(app([id]), dsSpec, amir)).issues, /column ghost_title not in dataset/);
});

test('task-checklist source:"records" is clean; a dataset assigneeField is column-checked', async () => {
  const recSpec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'C', body: { kind: 'pattern', pattern: 'task-checklist', config: { source: 'records', titleField: 'task' } } }],
  });
  assert.deepEqual((await validateAppSpec(app([]), recSpec, amir)).issues, []);

  const id = seedOrders();
  const dsSpec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'C', body: { kind: 'pattern', pattern: 'task-checklist', config: { source: { datasetId: id }, titleField: 'order_id', assigneeField: 'ghost_owner' } } }],
  });
  hasIssue((await validateAppSpec(app([id]), dsSpec, amir)).issues, /column ghost_owner not in dataset/);
});

// — 3.5d backend DSL functions —

/** A spec with a functions[] array (+ optional kpi function-card tab). */
function fnSpec(functions: unknown[], tabs: unknown[] = [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: 'x' }, columns: [{ field: 'a' }] } } }]): AppSpec {
  return parse({ version: 2, name: 'App', description: 'x', tabs, functions });
}

test('a valid aggregate function (granted source + real field) has NO issues', async () => {
  const id = seedOrders();
  const spec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: id }, columns: [{ field: 'order_id' }] } } }],
    functions: [{ id: 'net', name: 'Net', description: 'total net', kind: 'aggregate', source: { datasetId: id }, op: 'sum', field: 'net_amount' }],
  });
  assert.deepEqual((await validateAppSpec(app([id]), spec, amir)).issues, []);
});

test('an aggregate function over an UNGRANTED dataset is a blocking issue', async () => {
  const id = seedOrders();
  const spec = fnSpec([{ id: 'c', name: 'C', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'count' }]);
  const i = hasIssue((await validateAppSpec(app([]), spec, amir)).issues, /is not granted/);
  assert.match(i.path, /functions\[0\]\.source\.datasetId/);
});

test('an aggregate function field must exist — the issue LISTS the real columns', async () => {
  const id = seedOrders();
  const spec = fnSpec([{ id: 's', name: 'S', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'sum', field: 'ghost_amount' }]);
  const i = hasIssue((await validateAppSpec(app([id]), spec, amir)).issues, /column ghost_amount not in dataset/);
  assert.match(i.fix, /net_amount/);
});

test('a filter field on an aggregate function is column-checked too', async () => {
  const id = seedOrders();
  const spec = fnSpec([{ id: 'c', name: 'C', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'count', filters: [{ field: 'ghost', op: 'eq', value: 'open' }] }]);
  hasIssue((await validateAppSpec(app([id]), spec, amir)).issues, /column ghost not in dataset/);
});

test('an expression referencing a KNOWN function id is clean; an UNKNOWN ref is a blocking issue', async () => {
  const id = seedOrders();
  const good = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: id }, columns: [{ field: 'order_id' }] } } }],
    functions: [
      { id: 'total', name: 'T', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'count' },
      { id: 'ratio', name: 'R', description: 'x', kind: 'expression', expr: 'fn.total / 2' },
    ],
  });
  assert.deepEqual((await validateAppSpec(app([id]), good, amir)).issues, []);

  const bad = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: id }, columns: [{ field: 'order_id' }] } } }],
    functions: [{ id: 'ratio', name: 'R', description: 'x', kind: 'expression', expr: 'fn.missing + 1' }],
  });
  hasIssue((await validateAppSpec(app([id]), bad, amir)).issues, /references unknown function fn.missing/);
});

test('a reference CYCLE among functions is a blocking issue', async () => {
  const spec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: 'x' }, columns: [{ field: 'a' }] } } }],
    functions: [
      { id: 'x', name: 'X', description: 'x', kind: 'expression', expr: 'fn.y + 1' },
      { id: 'y', name: 'Y', description: 'y', kind: 'expression', expr: 'fn.x + 1' },
    ],
  });
  hasIssue((await validateAppSpec(app([]), spec, amir)).issues, /part of a reference cycle/);
});

test('duplicate function ids are a blocking issue', async () => {
  const spec = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: 'x' }, columns: [{ field: 'a' }] } } }],
    functions: [
      { id: 'dup', name: 'A', description: 'a', kind: 'expression', expr: '1' },
      { id: 'dup', name: 'B', description: 'b', kind: 'expression', expr: '2' },
    ],
  });
  hasIssue((await validateAppSpec(app([]), spec, amir)).issues, /duplicate function id/);
});

test('a kpi-overview function-card ref must name a DECLARED function', async () => {
  const id = seedOrders();
  const good = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'K', body: { kind: 'pattern', pattern: 'kpi-overview', config: { cards: [{ label: 'Net', function: { functionId: 'net' } }] } } }],
    functions: [{ id: 'net', name: 'Net', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'sum', field: 'net_amount' }],
  });
  assert.deepEqual((await validateAppSpec(app([id]), good, amir)).issues, []);

  const bad = parse({
    version: 2, name: 'App', description: 'x',
    tabs: [{ id: 't', label: 'K', body: { kind: 'pattern', pattern: 'kpi-overview', config: { cards: [{ label: 'X', function: { functionId: 'nope' } }] } } }],
    functions: [{ id: 'net', name: 'Net', description: 'x', kind: 'aggregate', source: { datasetId: id }, op: 'count' }],
  });
  const i = hasIssue((await validateAppSpec(app([id]), bad, amir)).issues, /function nope is not declared/);
  assert.match(i.fix, /net/);
});

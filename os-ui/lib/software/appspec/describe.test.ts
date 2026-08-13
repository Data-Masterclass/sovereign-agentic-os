/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * describe.test — the LEGIBILITY surface. `describeApp` reduces a spec to a plain-language map of
 * what each tab shows/does + its data source + role gate, preserving order and reporting EVERY
 * tab (gated included). Views are 'view', writers are 'action', custom blocks are 'custom'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppSpec, type AppSpec } from './schema.ts';
import { describeApp } from './describe.ts';

function spec(): AppSpec {
  const r = parseAppSpec({
    version: 2,
    name: 'Ops',
    description: 'Worked demo',
    theme: { css: '.card{border:0}' },
    tabs: [
      {
        id: 'orders',
        label: 'Orders',
        roleGate: 'builder',
        body: { kind: 'pattern', pattern: 'records-table', config: { source: { datasetId: 'ds_orders' }, columns: [{ field: 'id' }], search: true } },
      },
      {
        id: 'intake',
        label: 'New order',
        body: { kind: 'pattern', pattern: 'intake-wizard', config: { target: 'records', steps: [{ title: 'A', fields: [{ name: 'x', label: 'X', type: 'text' }] }], submitLabel: 'Save' } },
      },
      { id: 'widget', label: 'Widget', body: { kind: 'custom', html: '<h1>hi</h1>', data: { datasetId: 'ds_orders' } } },
      { id: 'plain', label: 'Plain', body: { kind: 'custom', html: '<p>x</p>' } },
    ],
  });
  assert.equal(r.ok, true);
  return (r as { ok: true; spec: AppSpec }).spec;
}

test('describeApp reports name, description, themed flag, and every tab in order', () => {
  const d = describeApp(spec());
  assert.equal(d.name, 'Ops');
  assert.equal(d.description, 'Worked demo');
  assert.equal(d.themed, true);
  assert.deepEqual(d.tabs.map((t) => t.label), ['Orders', 'New order', 'Widget', 'Plain']);
});

test('a view pattern is kind "view" with its dataset source and a plain-language what', () => {
  const orders = describeApp(spec()).tabs[0];
  assert.equal(orders.kind, 'view');
  assert.equal(orders.data, 'ds_orders');
  assert.equal(orders.roleGate, 'builder');
  assert.match(orders.what, /ds_orders/);
  assert.match(orders.what, /search/);
});

test('a write pattern is kind "action" (an interactive tab), with no dataset source', () => {
  const intake = describeApp(spec()).tabs[1];
  assert.equal(intake.kind, 'action');
  assert.equal(intake.data, null); // writes to the app's own records, not a dataset
  assert.match(intake.what, /saves a new record/i);
  assert.equal(intake.roleGate, null);
});

test('a custom block is kind "custom"; its injected data source is reported when present', () => {
  const [, , widget, plain] = describeApp(spec()).tabs;
  assert.equal(widget.kind, 'custom');
  assert.equal(widget.data, 'ds_orders');
  assert.match(widget.what, /sandboxed/i);
  assert.equal(plain.kind, 'custom');
  assert.equal(plain.data, null);
});

test('themed is false when no theme css is present', () => {
  const r = parseAppSpec({
    version: 2,
    name: 'x',
    description: 'y',
    tabs: [{ id: 't', label: 'T', body: { kind: 'custom', html: '<b>x</b>' } }],
  });
  assert.equal(r.ok, true);
  assert.equal(describeApp((r as { ok: true; spec: AppSpec }).spec).themed, false);
});

// ----------------------------------------------- 3.5b reads/writes/uses/serves legibility ----

function one(pattern: string, config: unknown, extra: Record<string, unknown> = {}): AppSpec {
  const r = parseAppSpec({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [{ id: 't1', label: 'T', ...extra, body: { kind: 'pattern', pattern, config } }],
  });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify((r as { issues: unknown[] }).issues));
  return (r as { ok: true; spec: AppSpec }).spec;
}

test('a view pattern READS its dataset and WRITES nothing', () => {
  const d = describeApp(one('records-table', { source: { datasetId: 'ds_o' }, columns: [{ field: 'id' }] })).tabs[0];
  assert.deepEqual(d.reads, [{ kind: 'dataset', id: 'ds_o' }]);
  assert.deepEqual(d.writes, []);
  assert.deepEqual(d.uses, []);
});

test('an interactive pattern WRITES records and reads nothing', () => {
  const d = describeApp(one('intake-wizard', { target: 'records', steps: [{ title: 'A', fields: [{ name: 'x', label: 'X', type: 'text' }] }], submitLabel: 'Save' })).tabs[0];
  assert.deepEqual(d.reads, []);
  assert.deepEqual(d.writes, [{ kind: 'records', label: 'app records' }]);
});

test('chart-explorer reads a METRIC (not a dataset)', () => {
  const d = describeApp(one('chart-explorer', { metric: { metricId: 'Orders.revenue' }, chart: 'line' })).tabs[0];
  assert.deepEqual(d.reads, [{ kind: 'metric', id: 'Orders.revenue' }]);
});

test('kpi-overview reads each card source (metrics + datasets), deduped', () => {
  const d = describeApp(one('kpi-overview', {
    cards: [
      { label: 'R', metric: { metricId: 'Orders.revenue' } },
      { label: 'C', dataset: { datasetId: 'ds_o', agg: 'count' } },
      { label: 'C2', dataset: { datasetId: 'ds_o', agg: 'sum', field: 'net' } }, // same dataset → deduped
    ],
  })).tabs[0];
  assert.deepEqual(d.reads, [
    { kind: 'metric', id: 'Orders.revenue' },
    { kind: 'dataset', id: 'ds_o' },
  ]);
});

test('landing enumerates every sub-block source across kpi + table blocks', () => {
  const d = describeApp(one('landing', {
    blocks: [
      { kind: 'markdown', content: '# hi' },
      { kind: 'kpi', cards: [{ label: 'R', metric: { metricId: 'M.rev' } }] },
      { kind: 'table', source: { datasetId: 'ds_t' }, columns: [{ field: 'a' }] },
    ],
  })).tabs[0];
  assert.deepEqual(d.reads, [
    { kind: 'metric', id: 'M.rev' },
    { kind: 'dataset', id: 'ds_t' },
  ]);
});

test('serves carries the tab↔story links (empty when none)', () => {
  const withStories = describeApp(one('records-table', { source: { datasetId: 'ds' }, columns: [{ field: 'id' }] }, {
    stories: [{ epicId: 'ep1', storyId: 's1' }],
  })).tabs[0];
  assert.deepEqual(withStories.serves, [{ epicId: 'ep1', storyId: 's1' }]);

  const none = describeApp(one('records-table', { source: { datasetId: 'ds' }, columns: [{ field: 'id' }] })).tabs[0];
  assert.deepEqual(none.serves, []);
});

// ----------------------------------------------- 3.5c INTERACTIVE (append) reads/writes ----

test('form is an action: writes records, reads nothing', () => {
  const d = describeApp(one('form', { target: 'records', fields: [{ name: 'title', label: 'T', type: 'text' }] })).tabs[0];
  assert.equal(d.kind, 'action');
  assert.deepEqual(d.reads, []);
  assert.deepEqual(d.writes, [{ kind: 'records', label: 'app records' }]);
  assert.match(d.what, /saves a new record/i);
});

test('assignment reads BOTH datasets (item source + assignee source) AND writes records', () => {
  const d = describeApp(one('assignment', {
    source: { datasetId: 'ds_cases' }, itemLabelField: 'name',
    assignTo: { datasetId: 'ds_emps', optionLabelField: 'full_name' },
  })).tabs[0];
  assert.equal(d.kind, 'action');
  assert.deepEqual(d.reads, [
    { kind: 'dataset', id: 'ds_cases' },
    { kind: 'dataset', id: 'ds_emps' },
  ]);
  assert.deepEqual(d.writes, [{ kind: 'records', label: 'app records' }]);
  assert.equal(d.data, 'ds_cases'); // primary source
});

test('approval-queue over "records" reads nothing; over a dataset reads that dataset — both write', () => {
  const rec = describeApp(one('approval-queue', { source: 'records', titleField: 'title' })).tabs[0];
  assert.deepEqual(rec.reads, []);
  assert.deepEqual(rec.writes, [{ kind: 'records', label: 'app records' }]);
  assert.equal(rec.data, null);

  const ds = describeApp(one('approval-queue', { source: { datasetId: 'ds_req' }, titleField: 'name' })).tabs[0];
  assert.deepEqual(ds.reads, [{ kind: 'dataset', id: 'ds_req' }]);
  assert.deepEqual(ds.writes, [{ kind: 'records', label: 'app records' }]);
  assert.equal(ds.data, 'ds_req');
});

test('task-checklist over a dataset reads it and writes records', () => {
  const d = describeApp(one('task-checklist', { source: { datasetId: 'ds_tasks' }, titleField: 'name', assigneeField: 'owner' })).tabs[0];
  assert.deepEqual(d.reads, [{ kind: 'dataset', id: 'ds_tasks' }]);
  assert.deepEqual(d.writes, [{ kind: 'records', label: 'app records' }]);
});

test('a custom block with injected data reads that dataset', () => {
  const r = parseAppSpec({
    version: 2,
    name: 'App',
    description: 'x',
    tabs: [{ id: 't', label: 'T', body: { kind: 'custom', html: '<b>x</b>', data: { datasetId: 'ds_c' } } }],
  });
  assert.equal(r.ok, true);
  const d = describeApp((r as { ok: true; spec: AppSpec }).spec).tabs[0];
  assert.deepEqual(d.reads, [{ kind: 'dataset', id: 'ds_c' }]);
  assert.deepEqual(d.writes, []);
});

// — 3.5d backend DSL functions section —

test('describeApp emits a functions section: name, description, kind, what, and reads', () => {
  const r = parseAppSpec({
    version: 2,
    name: 'Ops',
    description: 'x',
    tabs: [{ id: 'k', label: 'K', body: { kind: 'pattern', pattern: 'kpi-overview', config: { cards: [{ label: 'Net', function: { functionId: 'net' } }] } } }],
    functions: [
      { id: 'net', name: 'Net revenue', description: 'sum of net_amount', kind: 'aggregate', source: { datasetId: 'ds_orders' }, op: 'sum', field: 'net_amount' },
      { id: 'cnt', name: 'Order count', description: 'row count', kind: 'aggregate', source: { datasetId: 'ds_orders' }, op: 'count', filters: [{ field: 'status', op: 'eq', value: 'open' }] },
      { id: 'aov', name: 'AOV', description: 'net / count', kind: 'expression', expr: 'fn.net / fn.cnt' },
    ],
  });
  assert.equal(r.ok, true);
  const d = describeApp((r as { ok: true; spec: AppSpec }).spec);

  assert.equal(d.functions.length, 3);

  const net = d.functions[0];
  assert.equal(net.id, 'net');
  assert.equal(net.name, 'Net revenue');
  assert.equal(net.kind, 'aggregate');
  assert.deepEqual(net.reads, [{ kind: 'dataset', id: 'ds_orders' }]);
  assert.deepEqual(net.dependsOn, []);
  assert.match(net.what, /sum of net_amount over ds_orders/);

  const cnt = d.functions[1];
  assert.match(cnt.what, /filtered by status/);

  const aov = d.functions[2];
  assert.equal(aov.kind, 'expression');
  assert.deepEqual(aov.reads, []);
  assert.deepEqual(aov.dependsOn.sort(), ['cnt', 'net']);
  assert.match(aov.what, /fn\.net/);
  assert.match(aov.what, /fn\.cnt/);
});

test('an app with no functions has an empty functions section', () => {
  const d = describeApp(spec());
  assert.deepEqual(d.functions, []);
});

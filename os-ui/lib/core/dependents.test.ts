/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the stores so every OpenSearch mirror ping fails fast
// and each getCache() initialises an empty in-process Map (offline mode) — mirrors
// the apps.test.ts pattern. dependents.ts pulls in apps.ts (which pings on hydrate).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { dependentsOf, dependentsSummary } = await import('./dependents.ts');
const dataStore = await import('../data/store.ts');
const { __resetStore, createDataset, buildVersion, defineMeasure, datasetForScheduler } = dataStore;
const { measureMember } = await import('../metrics/model.ts');
const { __resetDashboards, saveDashboard } = await import('../dashboards/store.ts');
const { __resetStore: __resetAgents, createSystem } = await import('../agents/store.ts');
const { __resetAppsCache, createApp, patchAppDesign } = await import('../software/apps.ts');

type Principal = { id: string; domains: string[]; role: 'creator' | 'builder' | 'admin' };
const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };
const owner = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'admin' as const };

beforeEach(() => {
  __resetStore();
  __resetDashboards();
  __resetAgents();
  __resetAppsCache();
});

/** Build a Gold dataset with a `revenue` measure; return {datasetId, member, metricId}. */
function seedRevenue(): { datasetId: string; member: string; metricId: string } {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  defineMeasure(d.id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  const ds = datasetForScheduler(d.id)!;
  const measure = ds.measures.find((m) => m.name === 'revenue')!;
  return { datasetId: d.id, member: measureMember(ds, measure), metricId: `${d.id}.revenue` };
}

function panelSpec(name: string, view: string, member: string) {
  return { name, view, charts: [{ name: 'Revenue', vizType: 'big_number' as const, metrics: [member] }] };
}

test('dataset → dashboards: a panel that charts the dataset\'s member is a dependent', async () => {
  const { datasetId, member } = seedRevenue();
  saveDashboard(amir, 'dash_rev', panelSpec('Sales', 'Orders', member));
  const deps = await dependentsOf(datasetId);
  const dash = deps.filter((d) => d.tab === 'dashboards');
  assert.equal(dash.length, 1);
  assert.equal(dash[0].id, 'dash_rev');
});

test('dataset → dashboards: a dashboard on an UNRELATED member is NOT a dependent', async () => {
  const { datasetId } = seedRevenue();
  saveDashboard(amir, 'dash_other', panelSpec('Other', 'Whatever', 'Whatever.count'));
  const deps = await dependentsOf(datasetId);
  assert.equal(deps.filter((d) => d.tab === 'dashboards').length, 0);
});

test('metric → dashboards: the metric id resolves the same dashboard edge', async () => {
  const { member, metricId } = seedRevenue();
  saveDashboard(amir, 'dash_rev', panelSpec('Sales', 'Orders', member));
  const deps = await dependentsOf(metricId);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].tab, 'dashboards');
  assert.equal(deps[0].id, 'dash_rev');
});

test('dataset → agents: an agent granted the dataset id is a dependent', async () => {
  const { datasetId } = seedRevenue();
  const yaml = [
    'system: { name: uses_ds, domain: sales, visibility: Personal }',
    'entrypoint: a',
    `grants: { data: [{ id: ${datasetId}, capability: Read }], knowledge: [], tools: [], connections: [] }`,
    'agents: [{ id: a, role: does stuff }]',
  ].join('\n');
  createSystem({ id: 'amir', domains: ['sales'], role: 'creator' }, { name: 'uses_ds', yaml });
  const deps = await dependentsOf(datasetId);
  const ag = deps.filter((d) => d.tab === 'agents');
  assert.equal(ag.length, 1);
  assert.equal(ag[0].kind, 'agent');
});

test('dataset → agents: a FOLDER data grant (no item id) is NOT a dependent', async () => {
  const { datasetId } = seedRevenue();
  const yaml = [
    'system: { name: folder, domain: sales, visibility: Personal }',
    'entrypoint: a',
    'grants: { data: [{ folder: { path: /, scope: personal }, capability: Read }], knowledge: [], tools: [], connections: [] }',
    'agents: [{ id: a, role: does stuff }]',
  ].join('\n');
  createSystem({ id: 'amir', domains: ['sales'], role: 'creator' }, { name: 'folder', yaml });
  const deps = await dependentsOf(datasetId);
  assert.equal(deps.filter((d) => d.tab === 'agents').length, 0);
});

test('dataset → apps: an app granted the dataset id is a dependent', async () => {
  const { datasetId } = seedRevenue();
  const app = await createApp(owner, { name: 'RevApp', template: 'sovereign-app' });
  await patchAppDesign(app.id, owner, {
    grants: { connections: [], data: [{ id: datasetId, access: 'read-only' }], knowledge: [], files: [], metrics: [] },
  });
  const deps = await dependentsOf(datasetId);
  const apps = deps.filter((d) => d.tab === 'software');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].kind, 'app');
});

test('dataset → apps: an app WITHOUT the grant is NOT a dependent', async () => {
  const { datasetId } = seedRevenue();
  const app = await createApp(owner, { name: 'NoGrantApp', template: 'sovereign-app' });
  await patchAppDesign(app.id, owner, {
    grants: { connections: [], data: [{ id: 'ds_other', access: 'read-only' }], knowledge: [], files: [], metrics: [] },
  });
  const deps = await dependentsOf(datasetId);
  assert.equal(deps.filter((d) => d.tab === 'software').length, 0);
});

test('an unknown / dependency-free id yields an empty list without throwing', async () => {
  const deps = await dependentsOf('ds_doesnotexist000');
  assert.deepEqual(deps, []);
});

test('dependentsSummary is direction-aware', () => {
  const deps = [
    { kind: 'dashboard', id: 'd1', name: 'A', tab: 'dashboards' as const },
    { kind: 'app', id: 'a1', name: 'B', tab: 'software' as const },
  ];
  const brk = dependentsSummary(deps, 'break');
  assert.match(brk, /1 dashboard/);
  assert.match(brk, /1 app/);
  assert.match(brk, /break their access/);
  assert.match(dependentsSummary(deps, 'promote'), /re-point/);
  assert.match(dependentsSummary([], 'break'), /Nothing depends/);
});

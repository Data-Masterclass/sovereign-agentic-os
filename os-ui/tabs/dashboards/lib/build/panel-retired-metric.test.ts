/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A dashboard tile says what happened to its metric
 * USER STORY: As a dashboard viewer whose tile went blank because its metric was archived or
 *             deleted in KPIs, I want the tile to say so and what to do (restore it, or pick
 *             another metric), not to tell me to re-materialize a domain table.
 * ARCHITECTURE:
 *   - The REAL metric registry over the REAL dataset store: a gold dataset with a measure, a panel
 *     on its member, then the REAL `archiveMetric` / `deleteMetric`. The registry resolver and the
 *     new explainer run unmocked; only the governed SQL call (`explore`) is a fake, because no
 *     tile in this test may run a query.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore, createDataset, buildVersion, defineMeasure, datasetForScheduler } = await import('@tabs/data/lib/store');
const { measureMember } = await import('@tabs/metrics/lib/model');
const { archiveMetric, deleteMetric } = await import('@tabs/metrics/lib/lifecycle');
const { claimsFromUser, delegate } = await import('@tabs/data/lib/identity');
const { runPanelQuery } = await import('./panel-query.ts');

const amir = { id: 'amir', domains: ['sales'], role: 'builder' as const };
const outsider = { id: 'olga', domains: ['ops'], role: 'creator' as const };
const tokenFor = (u: { id: string; domains: string[]; role: 'builder' | 'creator' }) => delegate(claimsFromUser(u), 'domain');
let explored = 0;
const explore = (async () => {
  explored++;
  return { member: '', rows: [], securityContext: {}, sql: '', mode: 'live (sql)' };
}) as never;

function seed(): { member: string; metricId: string } {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  defineMeasure(d.id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  const ds = datasetForScheduler(d.id)!;
  return { member: measureMember(ds, ds.measures.find((m) => m.name === 'revenue')!), metricId: `${d.id}.revenue` };
}

beforeEach(() => {
  __resetStore();
  explored = 0;
});

const tile = (member: string) => ({ name: 'Revenue', vizType: 'big_number' as const, metrics: [member] });

test('a tile on an ARCHIVED metric says it was archived and can be restored', async () => {
  const { member, metricId } = seed();
  archiveMetric(metricId, amir);
  const res = await runPanelQuery('Orders', tile(member), tokenFor(amir), amir, { explore });
  assert.match(res.warning ?? '', new RegExp(`The metric “${member.replace('.', '\\.')}” this chart uses was archived`));
  assert.match(res.warning ?? '', /Restore it in KPIs/);
  assert.doesNotMatch(res.warning ?? '', /Re-materialize/);
  assert.equal(explored, 0);
});

test('a tile on a DELETED metric says it no longer exists and to pick another', async () => {
  const { member, metricId } = seed();
  deleteMetric(metricId, amir);
  const res = await runPanelQuery('Orders', tile(member), tokenFor(amir), amir, { explore });
  assert.match(res.warning ?? '', /no longer exists: the metric or the dataset it was defined on was deleted/);
  assert.doesNotMatch(res.warning ?? '', /Re-materialize/);
});

test('a metric that exists but is outside the viewer’s entitlement keeps the general advice, and its state is not told', async () => {
  const { member, metricId } = seed();
  archiveMetric(metricId, amir);
  const res = await runPanelQuery('Orders', tile(member), tokenFor(outsider), outsider, { explore });
  assert.doesNotMatch(res.warning ?? '', /archived/);
  assert.match(res.warning ?? '', /not available in the governed model/);
});

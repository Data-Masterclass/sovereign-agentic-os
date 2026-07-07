/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetDashboards, listDashboards, getDashboard, saveDashboard, setDashboardArchived, deleteDashboard, listDashboardVersions, restoreDashboardVersion, type Principal } from './store.ts';
import type { DashboardSpec } from './model.ts';

const admin: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const builder: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function spec(name = 'My Dash'): DashboardSpec {
  return { name, view: 'mine', charts: [] };
}

beforeEach(() => __resetDashboards());

test('fresh store starts empty (SEED is empty)', () => {
  const { mine, domain, marketplace } = listDashboards(admin);
  assert.equal(mine.length + domain.length + marketplace.length, 0);
});

test('saveDashboard creates a record owned by the user', () => {
  saveDashboard(builder, 'dash_1', spec('Sales KPIs'));
  const { mine } = listDashboards(builder);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, 'Sales KPIs');
});

test('getDashboard returns the record for the owner', () => {
  saveDashboard(builder, 'dash_2', spec('Revenue'));
  const d = getDashboard('dash_2', builder);
  assert.equal(d.id, 'dash_2');
});

test('getDashboard throws 403 for a non-owner without domain access', () => {
  saveDashboard(builder, 'dash_3', spec('Private'));
  const other: Principal = { id: 'other', domains: [], role: 'creator' };
  assert.throws(() => getDashboard('dash_3', other), (e: { status?: number }) => e.status === 403);
});

test('globalThis pin: dashState is shared under soa.dashboards.store', () => {
  saveDashboard(builder, 'dash_g', spec('Pinned'));
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.dashboards.store')] as { dashboards: unknown[] };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.equal(pinned.dashboards.length, 1, 'saved dashboard must appear in globalThis state');
});

// ------------------------------------------------ archive / delete / versions --

test('saveDashboard snapshots the prior spec; restore reverts + is itself versioned', () => {
  saveDashboard(builder, 'dash_v', spec('v0'));
  assert.equal(listDashboardVersions('dash_v', builder).length, 0);

  saveDashboard(builder, 'dash_v', spec('v1'));
  saveDashboard(builder, 'dash_v', spec('v2'));
  const history = listDashboardVersions('dash_v', builder);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal((history[1].state as { spec: DashboardSpec }).spec.name, 'v0');

  restoreDashboardVersion('dash_v', builder, 1); // v1 holds the original spec
  assert.equal(getDashboard('dash_v', builder).spec.name, 'v0');
  const after = listDashboardVersions('dash_v', builder);
  assert.equal(after.length, 3);
  assert.match(after[0].summary, /restore of v1/);
});

test('archive soft-hides a dashboard; unarchive restores it; delete purges history', () => {
  saveDashboard(builder, 'dash_a', spec('Archivable'));
  saveDashboard(builder, 'dash_a', spec('edited')); // creates a version
  setDashboardArchived('dash_a', builder, true);
  assert.ok(!listDashboards(builder).mine.some((d) => d.id === 'dash_a'));
  assert.ok(listDashboards(builder, { includeArchived: true }).mine.some((d) => d.id === 'dash_a'));

  setDashboardArchived('dash_a', builder, false);
  assert.ok(listDashboards(builder).mine.some((d) => d.id === 'dash_a'));

  deleteDashboard('dash_a', builder);
  assert.throws(() => getDashboard('dash_a', builder), (e: { status?: number }) => e.status === 404);
  // fresh dashboard reusing the id has clean history (purge worked).
  saveDashboard(builder, 'dash_a', spec('Fresh'));
  assert.equal(listDashboardVersions('dash_a', builder).length, 0);
});

test('archive / delete / restore obey owner authz (a non-owner is rejected 403)', () => {
  saveDashboard(builder, 'dash_o', spec('Owned'));
  saveDashboard(builder, 'dash_o', spec('e'));
  const intruder: Principal = { id: 'mallory', domains: ['sales'], role: 'admin' };
  assert.throws(() => setDashboardArchived('dash_o', intruder, true), (e: { status?: number }) => e.status === 403);
  assert.throws(() => deleteDashboard('dash_o', intruder), (e: { status?: number }) => e.status === 403);
  assert.throws(() => restoreDashboardVersion('dash_o', intruder, 1), (e: { status?: number }) => e.status === 403);
});

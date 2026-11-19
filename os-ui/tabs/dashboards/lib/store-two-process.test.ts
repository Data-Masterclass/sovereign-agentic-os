/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    An agent's dashboard write never overwrites a newer edit, nor a dashboard it may not edit
 * USER STORY: As a creator I move my dashboard into a folder while an agent (running in the worker
 *             pod) replaces its charts. After the agent finishes and os-ui restarts, my folder is
 *             still there. And an agent acting for someone else can never replace MY dashboard by
 *             passing its id — not even one created after the worker booted.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store and the REAL
 *     `create_dashboard` tool (`core/infra/two-process-fixture.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';
import * as store from '@tabs/dashboards/lib/store';
import { fromTiles } from '@tabs/dashboards/lib/model';

const KEYS = [Symbol.for('soa.dashboards.store')];
const INDEX = 'os-dashboards';
const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'creator' };
const carl: store.Principal = { id: 'carl', domains: ['sales'], role: 'builder' };

const spec = (name: string) => fromTiles(name, 'Orders', [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Orders.revenue' }], 'sales');

async function createDashboardTool() {
  const { dashboardWriteTools } = await import('@tabs/dashboards/mcp/dashboard-write-tools');
  const tool = dashboardWriteTools.find((t) => t.name === 'create_dashboard');
  assert.ok(tool, 'create_dashboard is registered');
  return tool!;
}

async function scenario() {
  const os = fakeCluster();
  store.__resetDashboards();
  const web = proc();
  const worker = proc(true);
  await as(web, KEYS, () => store.ensureHydrated());
  await as(worker, KEYS, () => store.ensureHydrated()); // the worker boots with an empty registry
  return { os, web, worker };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.ensureHydrated());
  return fresh;
}

test('create_dashboard in the worker cannot replace a dashboard of another user created after the worker booted', async () => {
  const { os, web, worker } = await scenario();
  try {
    await as(web, KEYS, () => store.saveDashboard(bea, 'dash_bea', spec('Bea sales')));
    const tool = await createDashboardTool();
    await as(worker, KEYS, async () => {
      await assert.rejects(
        () => tool.call(carl as never, { id: 'dash_bea', name: 'Hijacked', view: 'Orders', charts: [{ name: 'X', vizType: 'big_number_total', metric: 'Orders.revenue' }] }),
        (e: Error & { status?: number }) => e.status === 403,
        'replacing a dashboard one may not edit is refused',
      );
    });
    const doc = os.doc(INDEX, 'dash_bea') as { owner?: string; spec?: { name?: string } } | undefined;
    assert.equal(doc?.owner, 'bea', 'the mirrored dashboard still belongs to bea');
    assert.equal(doc?.spec?.name, 'Bea sales', "bea's dashboard is not replaced");
  } finally {
    os.restore();
    store.__resetDashboards();
  }
});

test('an agent replacing the charts in the worker keeps the folder move made meanwhile in os-ui', async () => {
  const { os, web } = await scenario();
  try {
    await as(web, KEYS, () => store.saveDashboard(bea, 'dash_bea', spec('Bea sales')));
    const worker = proc(true); // the worker boots after the dashboard exists: its copy is the one it hydrated
    await as(worker, KEYS, () => store.ensureHydrated());
    await as(web, KEYS, () => store.moveDashboard('dash_bea', bea, '/Weekly'));
    const tool = await createDashboardTool();
    await as(worker, KEYS, () =>
      tool.call(bea as never, { id: 'dash_bea', name: 'Bea sales v2', view: 'Orders', charts: [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Orders.revenue' }] }),
    );

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getDashboard('dash_bea', bea));
    assert.equal(back.folder, '/Weekly', 'the folder move made in os-ui must survive the agent replacing the charts');
    assert.equal(back.spec.name, 'Bea sales v2', "the agent's new spec is kept");
  } finally {
    os.restore();
    store.__resetDashboards();
  }
});

test('a dashboard deleted in os-ui is not brought back by an agent archiving it in the worker', async () => {
  const { os, web } = await scenario();
  try {
    await as(web, KEYS, () => store.saveDashboard(bea, 'dash_bea', spec('Bea sales')));
    const worker = proc(true); // the worker boots after the dashboard exists: its copy is the one it hydrated
    await as(worker, KEYS, () => store.ensureHydrated());
    await as(web, KEYS, () => store.deleteDashboard('dash_bea', bea));
    await as(worker, KEYS, () => store.setDashboardArchived('dash_bea', bea, true)); // its stale copy still has it
    assert.equal(os.doc(INDEX, 'dash_bea'), undefined, 'the worker write must not re-create the deleted dashboard');
  } finally {
    os.restore();
    store.__resetDashboards();
  }
});

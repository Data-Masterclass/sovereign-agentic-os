/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The agent worker sees dashboards created and deleted in the web app after it booted
 * USER STORY: As a creator I build or delete a dashboard; an agent run a minute later lists exactly
 *             what I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL dashboards store.
 */
import * as store from '@tabs/dashboards/lib/store';
import { fromTiles } from '@tabs/dashboards/lib/model';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';

const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'creator' };
const spec = (name: string) => fromTiles(name, 'Orders', [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Orders.revenue' }], 'sales');
let n = 0;
const seen = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

workerRefreshSuite({
  name: 'dashboards',
  keys: [Symbol.for('soa.dashboards.store')],
  index: 'os-dashboards',
  reset: () => store.__resetDashboards(),
  read: () => store.ensureHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: (label) => store.saveDashboard(bea, `dash_refresh_${++n}`, spec(label)).id,
  remove: (id) => store.deleteDashboard(id, bea),
  visible: (id) => seen(() => store.getDashboard(id, bea)) !== undefined && store.listDashboards(bea).mine.some((d) => d.id === id),
  edit: (id, value) => { store.renameDashboard(id, bea, value); },
  marker: (id) => seen(() => store.getDashboard(id, bea))?.spec.name,
});

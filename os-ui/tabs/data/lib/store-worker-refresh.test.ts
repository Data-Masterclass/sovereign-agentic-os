/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The agent worker sees datasets created and deleted in the web app after it booted
 * USER STORY: As a creator I add or delete a dataset in the Data tab; an agent run a minute later
 *             lists exactly what I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL data store, two
 *     simulated processes and one fake OpenSearch (`core/infra/two-process-fixture.ts`).
 */
import * as store from '@tabs/data/lib/store';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';
import { config } from '@core/kernel/config';

const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const seen = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

workerRefreshSuite({
  name: 'datasets',
  keys: [Symbol.for('soa.data.store')],
  index: config.datasetsIndex,
  reset: () => store.__resetStore(),
  read: () => store.ensureHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: (label) => store.createDataset(bea, { name: label, domain: 'sales' }).id,
  remove: (id) => { store.deleteDataset(id, bea); },
  visible: (id) => seen(() => store.getDataset(id, bea)) !== undefined && store.listDatasets(bea).mine.some((d) => d.id === id),
  edit: (id, value) => { store.setDocs(id, bea, { description: value }); },
  marker: (id) => seen(() => store.getDataset(id, bea))?.description,
});

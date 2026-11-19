/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The agent worker sees connections created and deleted in the web app after it booted
 * USER STORY: As a builder I add or delete a connection; an agent run a minute later uses exactly
 *             the connections I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL connections store.
 */
import { config } from '@core/kernel/config';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;
const store = await import('@tabs/connections/lib/store');
const bea = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' as const };
const find = async (id: string) => (await store.listConnectionsForUser(bea)).find((c) => c.id === id);

workerRefreshSuite({
  name: 'connections',
  keys: [Symbol.for('soa.connections.cache')],
  index: 'os-connections',
  reset: () => store.__resetConnections(),
  read: () => store.ensureConnectionsHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: async (label) => (await store.createConnection(bea, { name: label, template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'tok' })).id,
  remove: (id) => { store.deleteConnectionSync(id, bea); },
  visible: async (id) => (await find(id)) !== undefined,
  edit: async (id, value) => { await store.renameConnection(id, bea, value); },
  marker: async (id) => (await find(id))?.name,
});

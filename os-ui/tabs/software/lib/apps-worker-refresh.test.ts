/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agent worker's app LIST shows apps created and deleted in the web app after it booted
 * USER STORY: As a builder I create or delete an app; an agent run a minute later that lists apps
 *             sees exactly what I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL apps store. The
 *     by-id read already re-reads the mirror in the worker (PR #123); this covers the listing.
 */
import * as apps from '@tabs/software/lib/apps';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';
import { config } from '@core/kernel/config';

const bea = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' as const };
const find = async (id: string) => (await apps.listAppsForUser(bea)).find((a) => a.id === id);

workerRefreshSuite({
  name: 'apps',
  keys: [Symbol.for('soa.apps.cache')],
  index: config.appsIndex,
  reset: () => apps.__resetAppsCache(),
  read: () => apps.ensureHydrated(),
  enable: () => apps.enableMirrorRefresh(),
  create: async (label) => (await apps.createApp(bea, { name: label, template: 'sovereign-app' })).id,
  remove: (id) => apps.removeAppInternal(id),
  visible: async (id) => (await find(id)) !== undefined,
  edit: async (id, value) => { await apps.renameApp(id, bea, value); },
  marker: async (id) => (await find(id))?.name,
});

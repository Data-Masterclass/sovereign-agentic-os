/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    The agent worker sees workflows created and deleted in the web app after it booted
 * USER STORY: As a creator I write or delete a workflow in the Knowledge tab; an agent run a minute
 *             later grounds on exactly what I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL knowledge store.
 */
import * as store from '@tabs/knowledge/lib/store';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';

const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'creator' };
const seen = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

workerRefreshSuite({
  name: 'knowledge workflows',
  keys: [Symbol.for('soa.knowledge.store')],
  index: 'os-knowledge-records',
  reset: () => store.__resetStore(),
  read: () => store.ensureHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: (label) => store.createWorkflow(bea, { title: label }).id,
  remove: (id) => {
    store.archiveWorkflow(id, bea);
    store.deleteWorkflow(id, bea);
  },
  visible: (id) => seen(() => store.getWorkflow(id, bea)) !== undefined,
  edit: (id, value) => {
    const cur = store.getWorkflow(id, bea);
    store.updateWorkflow(id, bea, { md: cur.md.replace(/\n*$/, `\n\n${value}\n`), sha: cur.sha });
  },
  marker: (id) => (seen(() => store.getWorkflow(id, bea))?.md.includes('written by the agent') ? 'written by the agent' : undefined),
});

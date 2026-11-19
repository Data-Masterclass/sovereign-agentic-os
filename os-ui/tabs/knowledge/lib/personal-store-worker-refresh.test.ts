/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    The agent worker sees personal notes created and deleted in the web app after it booted
 * USER STORY: As a creator I add or delete a personal note; an agent run a minute later that is
 *             granted my notes reads exactly what I have, without the worker pod being restarted.
 * ARCHITECTURE:
 *   - The shared scenarios (`core/infra/worker-refresh-suite.ts`) over the REAL personal-notes store.
 */
import * as store from '@tabs/knowledge/lib/personal-store';
import { workerRefreshSuite } from '@core/infra/worker-refresh-suite';

const bea = { id: 'bea', domains: ['sales'], role: 'creator' as const };
const seen = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

workerRefreshSuite({
  name: 'personal knowledge notes',
  keys: [Symbol.for('soa.knowledge.personal-store')],
  index: 'os-personal-knowledge',
  reset: () => store.__resetStore(),
  read: () => store.ensureHydrated(),
  enable: () => store.enableMirrorRefresh(),
  create: (label) => store.createPersonalKnowledge(bea, { title: label, md: 'Acme ships on Tuesdays.' }).id,
  remove: (id) => store.deletePersonalKnowledge(id, bea),
  visible: (id) => seen(() => store.getPersonalKnowledge(id, bea)) !== undefined,
  edit: (id, value) => { store.updatePersonalKnowledge(id, bea, { md: value }); },
  marker: (id) => seen(() => store.getPersonalKnowledge(id, bea))?.md,
});

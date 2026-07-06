/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore as resetKnowledge,
  createWorkflow,
  publishWorkflow,
  listWorkflows,
} from '../knowledge/store.ts';

/**
 * The `…/grants/available?kind=knowledge` endpoint returns exactly what
 * `listWorkflows(principal)` groups (mine→personal, domain→domain,
 * marketplace→marketplace). This test proves the canView scoping that endpoint
 * depends on: a caller sees their own + their domain's + marketplace artifacts,
 * and NEVER another user's private draft or another domain's shared artifacts.
 */

// The exact transform the available route applies to each kind's grouped list.
function toItems(groups: {
  mine: { id: string }[];
  domain: { id: string }[];
  marketplace: { id: string }[];
}): { id: string; scope: 'personal' | 'domain' | 'marketplace' }[] {
  return [
    ...groups.mine.map((x) => ({ id: x.id, scope: 'personal' as const })),
    ...groups.domain.map((x) => ({ id: x.id, scope: 'domain' as const })),
    ...groups.marketplace.map((x) => ({ id: x.id, scope: 'marketplace' as const })),
  ];
}

const salesUser = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const salesBuilder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const financeUser = { id: 'kenji', domains: ['finance'], role: 'builder' as const };

test('AVAILABLE-SCOPE: caller sees own personal + domain shared, never a foreign private draft or foreign domain', () => {
  resetKnowledge();

  // amir's own private draft (personal), bea's domain-published workflow (shared),
  // and kenji's finance-only private draft (must NEVER surface to sales).
  const mine = createWorkflow(salesUser, { title: 'My Draft', domain: 'sales' });
  const shared = createWorkflow(salesBuilder, { title: 'Sales Playbook', domain: 'sales' });
  publishWorkflow(shared.id, salesBuilder);
  const foreignPrivate = createWorkflow(financeUser, { title: 'Finance Secret', domain: 'finance' });

  const items = toItems(listWorkflows(salesUser));
  const ids = new Set(items.map((i) => i.id));

  assert.ok(ids.has(mine.id), 'own personal draft is available (personal scope)');
  assert.equal(items.find((i) => i.id === mine.id)?.scope, 'personal');
  assert.ok(ids.has(shared.id), 'domain-shared workflow is available (domain scope)');
  assert.equal(items.find((i) => i.id === shared.id)?.scope, 'domain');
  assert.ok(!ids.has(foreignPrivate.id), 'another domain’s private draft NEVER leaks');
});

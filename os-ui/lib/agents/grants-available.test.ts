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
import {
  __resetStore as resetPersonal,
  createPersonalKnowledge,
  listPersonalKnowledge,
} from '../knowledge/personal-store.ts';

/**
 * The `…/grants/available?kind=knowledge` endpoint returns exactly what
 * `listWorkflows(principal)` + `listPersonalKnowledge(principal)` group together
 * (mine→personal, domain→domain, marketplace→marketplace). These tests prove:
 *
 * 1. The canView scoping that the endpoint depends on: a caller sees their own +
 *    their domain's + marketplace artifacts, and NEVER another user's private draft
 *    or another domain's shared artifacts (workflow store).
 * 2. Personal knowledge entries (pk_xxx) are included in the combined knowledge
 *    available list — the root cause of the "Purchasing Details shows as wf_xxx" bug.
 * 3. The combined list carries correct names (titles), not raw ids.
 */

// The exact transform the available route applies to each kind's grouped list.
function toItems(groups: {
  mine: { id: string; title?: string; name?: string }[];
  domain: { id: string; title?: string; name?: string }[];
  marketplace: { id: string; title?: string; name?: string }[];
}): { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' }[] {
  const nm = (x: { title?: string; name?: string }) => x.title ?? x.name ?? '';
  return [
    ...groups.mine.map((x) => ({ id: x.id, name: nm(x), scope: 'personal' as const })),
    ...groups.domain.map((x) => ({ id: x.id, name: nm(x), scope: 'domain' as const })),
    ...groups.marketplace.map((x) => ({ id: x.id, name: nm(x), scope: 'marketplace' as const })),
  ];
}

// Combined helper — mirrors what the route now does for kind=knowledge.
function combinedKnowledgeItems(user: { id: string; domains: string[]; role: 'creator' | 'builder' | 'domain_admin' | 'admin' }) {
  return [
    ...toItems(listWorkflows(user)),
    ...toItems(listPersonalKnowledge(user)),
  ];
}

const salesUser = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const salesBuilder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const financeUser = { id: 'kenji', domains: ['finance'], role: 'builder' as const };

test('AVAILABLE-SCOPE: caller sees own personal + domain shared, never a foreign private draft or foreign domain', () => {
  resetKnowledge();
  resetPersonal();

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
  assert.ok(!ids.has(foreignPrivate.id), "another domain's private draft NEVER leaks");
});

test('AVAILABLE-KNOWLEDGE: personal knowledge entries (pk_xxx) are included in the combined knowledge list', () => {
  resetKnowledge();
  resetPersonal();

  // A personal knowledge entry — the kind that was missing and showing as a raw id.
  const purchasing = createPersonalKnowledge(salesUser, { title: 'Purchasing Details', domain: 'sales' });
  // A workflow in the same user's domain.
  const playbook = createWorkflow(salesUser, { title: 'Onboarding Playbook', domain: 'sales' });

  const items = combinedKnowledgeItems(salesUser);
  const ids = new Set(items.map((i) => i.id));

  assert.ok(ids.has(purchasing.id), 'personal knowledge entry is in the combined available list');
  assert.ok(ids.has(playbook.id), 'workflow is still in the combined available list');

  // Names must be human titles — never the raw machine id.
  const purchasingItem = items.find((i) => i.id === purchasing.id);
  assert.equal(purchasingItem?.name, 'Purchasing Details', 'personal knowledge item carries its human title');
  assert.notEqual(purchasingItem?.name, purchasing.id, 'name must NOT be the raw id');

  const playbookItem = items.find((i) => i.id === playbook.id);
  assert.equal(playbookItem?.name, 'Onboarding Playbook', 'workflow item carries its human title');
});

test('AVAILABLE-KNOWLEDGE: personal knowledge from another user is NOT visible to unrelated user', () => {
  resetKnowledge();
  resetPersonal();

  // kenji creates a private personal knowledge entry in the finance domain.
  const secret = createPersonalKnowledge(financeUser, { title: 'Finance Secrets', domain: 'finance' });

  // salesUser must NOT see kenji's private entry.
  const items = combinedKnowledgeItems(salesUser);
  const ids = new Set(items.map((i) => i.id));
  assert.ok(!ids.has(secret.id), "another user's private personal knowledge must not leak");
});

test('AVAILABLE-KNOWLEDGE: combined list preserves correct scope badges for personal knowledge', () => {
  resetKnowledge();
  resetPersonal();

  const mine = createPersonalKnowledge(salesUser, { title: 'My Notes', domain: 'sales' });

  const items = combinedKnowledgeItems(salesUser);
  const item = items.find((i) => i.id === mine.id);
  assert.equal(item?.scope, 'personal', "owner's personal entry has personal scope");
});

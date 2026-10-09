/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * DLS test for the `/api/knowledge/docs` listing filter. The route pushes down the
 * SAME `dlsFilter` the governed retrieval path uses, so the docs list is scoped to
 * exactly what the caller may see. We assert (1) the pushed-down clauses are the
 * right grant set for a creator vs a builder, and (2) the code-side predicate
 * (`canSee`) — which the same units are re-checked against — denies a creator any
 * cross-domain or other-user doc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dlsFilter, canSee } from './retrieve.ts';
import type { Provenance } from './chunk.ts';

const creator = { id: 'stu-a', domains: ['agentic-leader-q3-2026'], role: 'creator' as const };
const builder = { id: 'instructor', domains: ['agentic-leader-q3-2026'], role: 'builder' as const };

function clauses(principal: Parameters<typeof dlsFilter>[0]): string {
  return JSON.stringify(dlsFilter(principal));
}

test('SECURITY: a creator filter never selects Personal docs by visibility alone', () => {
  const f = clauses(creator);
  // Owner-scoped Personal is allowed only via the owner term, not a bare Personal
  // visibility clause — so another student's Personal doc is NOT selected.
  assert.match(f, /"owner":"stu-a"/, 'owner term present');
  assert.doesNotMatch(f, /"visibility":"Personal"/, 'no blanket Personal clause for a creator');
  assert.match(f, /"visibility":"Marketplace"/);
  assert.match(f, /"visibility":"Shared"/);
});

test('a builder filter DOES include same-domain Personal (instructor stewardship)', () => {
  const f = clauses(builder);
  assert.match(f, /"visibility":"Personal"/, 'builder sees same-domain Personal drafts');
});

const prov = (over: Partial<Provenance>): Provenance => ({
  domain: 'other-domain', workflowId: null, stepId: null, type: 'workflow', actor: null,
  owner: 'someone-else', version: '1', visibility: 'Personal',
  updatedAt: new Date().toISOString(), trust: 0.5, authority: 0.5, ...over,
});

test('SECURITY: a creator cannot see another domain / another user doc', () => {
  assert.equal(canSee(prov({ visibility: 'Personal', owner: 'other-stu', domain: 'agentic-leader-q3-2026' }), creator), false, 'peer Personal in same domain denied');
  assert.equal(canSee(prov({ visibility: 'Shared', domain: 'test' }), creator), false, 'cross-domain Shared denied');
  assert.equal(canSee(prov({ visibility: 'Personal', domain: 'test', owner: 'admin' }), creator), false, 'cross-domain Personal denied');
});

test('a creator sees own docs, own-domain Shared, and Marketplace', () => {
  assert.equal(canSee(prov({ owner: 'stu-a', domain: 'agentic-leader-q3-2026' }), creator), true, 'own doc');
  assert.equal(canSee(prov({ visibility: 'Shared', domain: 'agentic-leader-q3-2026' }), creator), true, 'own-domain Shared');
  assert.equal(canSee(prov({ visibility: 'Marketplace' }), creator), true, 'Marketplace');
});

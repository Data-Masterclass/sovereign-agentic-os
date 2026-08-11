/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * 0.6.103 attach coverage: the WORKFLOW-anchor attach (Business Process = a knowledge
 * workflow ref that becomes the anchor) and the SOFTWARE-app attach (the store side of
 * the picker that now lists apps). Both go through the same store setters the solution
 * route calls after `resolveLinkedComponent` (which the route re-resolves through each
 * tab's canView gate — mocked here by registering the reference card directly).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetBets,
  createBet,
  addComponent,
  setBetWorkflow,
  getSolution,
} from './store.ts';
import { __resetSources, __resetStrategy, registerLinkedArtifact } from './sources.ts';
import { BetError, type Actor } from './model.ts';

const sara: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

beforeEach(() => { __resetBets(); __resetSources(); __resetStrategy(); });

function newBet() {
  return createBet(sara, {
    name: 'Ship the app',
    problem: { who: 'Ops', need: 'automate onboarding', obstacle: '', impact: '' },
    pillarId: 'pillar_onboarding',
    targetValue: 500_000,
    goLive: '2026-12-31',
  });
}

test('workflow-anchor attach: a knowledge workflow ref can be set as the Business Process anchor', () => {
  const bet = newBet();
  // Register a real workflow reference card (as resolveLinkedComponent('knowledge', …) would).
  registerLinkedArtifact({ id: 'wf_1', tab: 'knowledge', title: 'Onboarding workflow', domain: 'sales', visibility: 'shared', lifecycle: 'published' });
  const wf = addComponent(bet.id, sara, { tab: 'knowledge', artifactId: 'wf_1', plannedReady: '2026-07-01' }).ref;

  setBetWorkflow(bet.id, wf.id, sara);
  const sol = getSolution(bet.id, sara);
  assert.equal(sol.anchor?.id, wf.id, 'the workflow ref is the anchor (Business Process)');
  assert.equal(sol.anchor?.tab, 'knowledge');
});

test('workflow-anchor attach: a non-knowledge ref is rejected as the anchor', () => {
  const bet = newBet();
  registerLinkedArtifact({ id: 'app_1', tab: 'software', title: 'Onboarding app', domain: 'sales', visibility: 'personal', lifecycle: 'draft' });
  const app = addComponent(bet.id, sara, { tab: 'software', artifactId: 'app_1', plannedReady: '2026-07-01' }).ref;
  assert.throws(() => setBetWorkflow(bet.id, app.id, sara), BetError);
});

test('software-app attach: a visible software app attaches as a software component ref', () => {
  const bet = newBet();
  // The picker lists apps (available route → listAppsForUser); attach re-resolves the
  // id and registers the reference card. Simulate that resolved card, then attach.
  registerLinkedArtifact({ id: 'app_ship', tab: 'software', title: 'Onboarding app', domain: 'sales', visibility: 'shared', lifecycle: 'deployed' });
  const { ref } = addComponent(bet.id, sara, { tab: 'software', artifactId: 'app_ship', plannedReady: '2026-08-01' });

  assert.equal(ref.tab, 'software');
  assert.equal(ref.artifactId, 'app_ship');
  assert.equal(ref.origin, 'linked', 'a real app is LINKED, not scaffolded');
  const nodes = getSolution(bet.id, sara).nodes;
  assert.ok(nodes.some((n) => n.artifactId === 'app_ship'), 'the app appears in the solution nodes');
});

test('software-app attach: an unregistered id is a typed not_found (no silent link)', () => {
  const bet = newBet();
  assert.throws(() => addComponent(bet.id, sara, { tab: 'software', artifactId: 'ghost', plannedReady: '2026-08-01' }), BetError);
});

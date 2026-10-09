/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Placeholder components (0.6.103): a named stand-in for an artifact that doesn't
 * exist yet, and the "Create real <kind>" rebind that turns it into a real scaffolded
 * artifact while KEEPING the ref id (so interplay edges + the anchor survive).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetBets,
  createBet,
  getBet,
  addPlaceholder,
  createFromPlaceholder,
  wireComponents,
  setBetWorkflow,
  getSolution,
} from './store.ts';
import { __resetSources, __resetStrategy, resolveArtifact } from './sources.ts';
import { BetError, type Actor } from './model.ts';

const sara: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

beforeEach(() => {
  __resetBets();
  __resetSources();
  __resetStrategy();
});

function newBet() {
  return createBet(sara, {
    name: 'Reduce churn',
    problem: { who: 'Retention', need: 'Cut at-risk churn', obstacle: '', impact: '' },
    pillarId: 'pillar_retention',
    targetValue: 1_000_000,
    goLive: '2026-12-31',
  });
}

test('addPlaceholder: adds a named stand-in with no real artifact', () => {
  const bet = newBet();
  const { ref } = addPlaceholder(bet.id, sara, { tab: 'agent', name: 'Retention agent' });
  assert.equal(ref.placeholder, true);
  assert.equal(ref.placeholderName, 'Retention agent');
  assert.ok(ref.artifactId.startsWith('placeholder:'), 'synthetic id — no real artifact');
  assert.equal(resolveArtifact(ref.artifactId), null, 'no real artifact exists yet');
  assert.equal(getBet(bet.id, sara).components.length, 1);
});

test('addPlaceholder: an empty name is a typed bad request', () => {
  const bet = newBet();
  assert.throws(() => addPlaceholder(bet.id, sara, { tab: 'agent', name: '  ' }), BetError);
});

test('createFromPlaceholder: scaffolds a real artifact and REBINDS the same ref id', () => {
  const bet = newBet();
  const { ref } = addPlaceholder(bet.id, sara, { tab: 'agent', name: 'Retention agent' });
  const refIdBefore = ref.id;
  const phArtifactId = ref.artifactId;

  const out = createFromPlaceholder(bet.id, sara, ref.id);

  assert.equal(out.ref.id, refIdBefore, 'the ref id is stable — edges/anchor survive');
  assert.notEqual(out.artifactId, phArtifactId, 'rebound to a NEW real artifact id');
  assert.ok(!out.artifactId.startsWith('placeholder:'), 'the new id is a real artifact id');
  assert.equal(out.ref.placeholder, undefined, 'placeholder flag cleared');
  assert.equal(out.ref.placeholderName, undefined, 'placeholder name cleared');
  assert.equal(out.tab, 'agent');

  // The real artifact now exists, is titled from the placeholder, tagged to the bet.
  const art = resolveArtifact(out.artifactId);
  assert.ok(art, 'a real artifact was scaffolded');
  assert.equal(art!.title, 'Retention agent');
  assert.equal(art!.lifecycle, 'planned');
  assert.ok(art!.bigBetIds.includes(bet.id), 'tagged to the bet');
});

test('createFromPlaceholder: interplay edges keyed off the ref id survive the rebind', () => {
  const bet = newBet();
  const a = addPlaceholder(bet.id, sara, { tab: 'agent', name: 'Agent A' }).ref;
  const b = addPlaceholder(bet.id, sara, { tab: 'dashboard', name: 'Dash B' }).ref;
  wireComponents(bet.id, a.id, b.id, 'feeds', sara);

  createFromPlaceholder(bet.id, sara, a.id); // realize A

  const sol = getSolution(bet.id, sara);
  assert.equal(sol.edges.length, 1, 'the edge still exists (ref ids unchanged)');
  assert.equal(sol.edges[0].from, a.id);
  assert.equal(sol.edges[0].to, b.id);
});

test('createFromPlaceholder: a knowledge placeholder can anchor, and rebinding keeps it the anchor', () => {
  const bet = newBet();
  const wf = addPlaceholder(bet.id, sara, { tab: 'knowledge', name: 'Onboarding workflow' }).ref;
  setBetWorkflow(bet.id, wf.id, sara);
  assert.equal(getSolution(bet.id, sara).anchor?.id, wf.id);

  createFromPlaceholder(bet.id, sara, wf.id);

  const sol = getSolution(bet.id, sara);
  assert.equal(sol.anchor?.id, wf.id, 'still the anchor after the rebind');
  assert.equal(sol.anchor?.placeholder, undefined, 'and no longer a placeholder');
});

test('createFromPlaceholder: refuses a non-placeholder ref', () => {
  const bet = newBet();
  const wf = addPlaceholder(bet.id, sara, { tab: 'knowledge', name: 'W' }).ref;
  createFromPlaceholder(bet.id, sara, wf.id); // now real
  assert.throws(() => createFromPlaceholder(bet.id, sara, wf.id), BetError);
});

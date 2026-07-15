/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The solution BLUEPRINT (Phase 1, schema layer): the anchor-workflow invariant,
 * interplay-edge add/validate/dedupe, edges referencing ComponentRef ids (never
 * artifactIds), edge cleanup on node removal, and back-compat round-tripping of a
 * bet that never opened the canvas. Store-level only — no UI/canvas this phase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetBets,
  addComponent,
  createBet,
  getSolution,
  removeComponent,
  savePositions,
  setBetWorkflow,
  unwireComponents,
  updateBet,
  wireComponents,
  listBetVersions,
  restoreBetVersion,
} from './store.ts';
import { __resetSources, __resetStrategy } from './sources.ts';
import { BetError, type Actor, type Principal } from './model.ts';

const sara: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };
const outsider: Principal = { id: 'mo', domains: ['ops'], role: 'creator' };

function reset() {
  __resetBets();
  __resetSources();
  __resetStrategy();
}

/** A bet with a knowledge (workflow) ref + a data ref + an agent ref, all scaffolded. */
function seedBet() {
  const bet = createBet(sara, {
    name: 'Reduce churn',
    problem: { who: 'Sales', need: 'cut churn', obstacle: 'no signal', impact: '€1m' },
    targetValue: 1_000_000,
    goLive: '2026-12-01',
  });
  const wf = addComponent(bet.id, sara, { tab: 'knowledge', scaffold: { title: 'Retention playbook' }, plannedReady: '2026-06-01' }).ref;
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn mart' }, plannedReady: '2026-07-01' }).ref;
  const agent = addComponent(bet.id, sara, { tab: 'agent', scaffold: { title: 'Retention agent' }, plannedReady: '2026-08-01' }).ref;
  return { betId: bet.id, wf, data, agent };
}

// ---------------------------------------------------------- anchor invariant --

test('anchor: setBetWorkflow marks EXACTLY ONE knowledge ref as anchor-workflow', () => {
  reset();
  const { betId, wf } = seedBet();
  setBetWorkflow(betId, wf.id, sara);
  const sol = getSolution(betId, sara);
  assert.equal(sol.anchor?.id, wf.id);
  assert.equal(sol.anchor?.role, 'anchor-workflow');
  const anchors = sol.nodes.filter((n) => n.role === 'anchor-workflow');
  assert.equal(anchors.length, 1, 'exactly one anchor node');
});

test('anchor: a second knowledge ref moving in DEMOTES the prior anchor (still exactly one)', () => {
  reset();
  const { betId, wf } = seedBet();
  const wf2 = addComponent(betId, sara, { tab: 'knowledge', scaffold: { title: 'Second playbook' }, plannedReady: '2026-09-01' }).ref;
  setBetWorkflow(betId, wf.id, sara);
  setBetWorkflow(betId, wf2.id, sara);
  const sol = getSolution(betId, sara);
  assert.equal(sol.anchor?.id, wf2.id);
  assert.equal(sol.nodes.filter((n) => n.role === 'anchor-workflow').length, 1);
  assert.equal(sol.nodes.find((n) => n.id === wf.id)?.role, 'component', 'prior anchor demoted to component');
});

test('anchor: a non-knowledge ref is REJECTED as the anchor', () => {
  reset();
  const { betId, data } = seedBet();
  assert.throws(() => setBetWorkflow(betId, data.id, sara), (e: unknown) => e instanceof BetError && e.status === 400);
});

test('anchor: resolves by artifactId too, and clears on empty', () => {
  reset();
  const { betId, wf } = seedBet();
  setBetWorkflow(betId, wf.artifactId, sara); // by artifactId
  assert.equal(getSolution(betId, sara).anchor?.id, wf.id);
  setBetWorkflow(betId, undefined, sara); // clear
  const sol = getSolution(betId, sara);
  assert.equal(sol.anchor, null);
  assert.equal(sol.nodes.filter((n) => n.role === 'anchor-workflow').length, 0);
});

// ------------------------------------------------------- edge add / validate --

test('wire: appends an edge referencing REF ids (not artifactIds)', () => {
  reset();
  const { betId, data, agent } = seedBet();
  const { edge } = wireComponents(betId, data.id, agent.id, 'feeds', sara);
  assert.equal(edge.from, data.id);
  assert.equal(edge.to, agent.id);
  assert.equal(edge.relation, 'feeds');
  // The edge stores REF ids, and those are NOT the artifact ids.
  assert.notEqual(data.id, data.artifactId);
  assert.notEqual(edge.from, data.artifactId);
  const sol = getSolution(betId, sara);
  assert.equal(sol.edges.length, 1);
  assert.equal(sol.edges[0].id, edge.id);
});

test('wire: rejects unknown refs, self-edge, and an invalid relation', () => {
  reset();
  const { betId, data, agent } = seedBet();
  assert.throws(() => wireComponents(betId, 'nope', agent.id, 'feeds', sara), (e: unknown) => e instanceof BetError && e.status === 404);
  assert.throws(() => wireComponents(betId, data.id, 'nope', 'feeds', sara), (e: unknown) => e instanceof BetError && e.status === 404);
  assert.throws(() => wireComponents(betId, data.id, data.id, 'feeds', sara), (e: unknown) => e instanceof BetError && e.status === 400);
  // @ts-expect-error — invalid relation at the type boundary; store still guards at runtime.
  assert.throws(() => wireComponents(betId, data.id, agent.id, 'bogus', sara), (e: unknown) => e instanceof BetError && e.status === 400);
});

test('wire: rejects a DUPLICATE edge (same from/to/relation), allows a different relation', () => {
  reset();
  const { betId, data, agent } = seedBet();
  wireComponents(betId, data.id, agent.id, 'feeds', sara);
  assert.throws(() => wireComponents(betId, data.id, agent.id, 'feeds', sara), (e: unknown) => e instanceof BetError && e.status === 409);
  // Same pair, different relation → allowed.
  wireComponents(betId, data.id, agent.id, 'triggers', sara);
  assert.equal(getSolution(betId, sara).edges.length, 2);
});

test('unwire: removes an edge by id; unknown id → 404', () => {
  reset();
  const { betId, data, agent } = seedBet();
  const { edge } = wireComponents(betId, data.id, agent.id, 'feeds', sara);
  unwireComponents(betId, edge.id, sara);
  assert.equal(getSolution(betId, sara).edges.length, 0);
  assert.throws(() => unwireComponents(betId, edge.id, sara), (e: unknown) => e instanceof BetError && e.status === 404);
});

// ------------------------------------------------ node removal drops its edges --

test('removeComponent drops every edge touching the removed ref AND clears the anchor', () => {
  reset();
  const { betId, wf, data, agent } = seedBet();
  setBetWorkflow(betId, wf.id, sara);
  wireComponents(betId, data.id, agent.id, 'feeds', sara);
  wireComponents(betId, wf.id, agent.id, 'triggers', sara);
  savePositions(betId, { [data.id]: { x: 1, y: 2 }, [agent.id]: { x: 3, y: 4 } }, sara);

  // Removing the anchor workflow: its edge goes, and the anchor clears.
  removeComponent(betId, sara, wf.id);
  let sol = getSolution(betId, sara);
  assert.equal(sol.anchor, null, 'anchor cleared when the anchor ref is removed');
  assert.equal(sol.edges.length, 1, 'only the data→agent edge survives');
  assert.equal(sol.edges[0].from, data.id);

  // Removing an endpoint drops the remaining edge + its saved position.
  removeComponent(betId, sara, data.id);
  sol = getSolution(betId, sara);
  assert.equal(sol.edges.length, 0);
  assert.equal(sol.positions[data.id], undefined, 'position for the removed ref dropped');
});

// -------------------------------------------------------------- positions -----

test('savePositions keeps only on-bet refs and rejects non-finite coords', () => {
  reset();
  const { betId, data } = seedBet();
  savePositions(betId, { [data.id]: { x: 10, y: 20 }, stray: { x: 0, y: 0 } }, sara);
  const sol = getSolution(betId, sara);
  assert.deepEqual(sol.positions, { [data.id]: { x: 10, y: 20 } }, 'stray id ignored');
  assert.throws(
    () => savePositions(betId, { [data.id]: { x: NaN, y: 1 } }, sara),
    (e: unknown) => e instanceof BetError && e.status === 400,
  );
});

// ------------------------------------------------------------- governance -----

test('governance: an outsider (non-member, other domain) cannot read or edit the blueprint', () => {
  reset();
  const { betId, data, agent } = seedBet();
  assert.throws(() => getSolution(betId, outsider), (e: unknown) => e instanceof BetError && e.status === 403);
  assert.throws(() => wireComponents(betId, data.id, agent.id, 'feeds', outsider), (e: unknown) => e instanceof BetError && e.status === 403);
});

// -------------------------------------------------------------- back-compat ---

test('back-compat: a bet with no blueprint reads empty shapes (never null) and has no serialized solution', () => {
  reset();
  const bet = createBet(sara, {
    name: 'No-canvas bet',
    problem: { who: 'Ops', need: 'x', obstacle: 'y', impact: 'z' },
    targetValue: 1,
    goLive: '2026-12-01',
  });
  assert.equal((bet as { blueprint?: unknown }).blueprint, undefined, 'blueprint omitted when empty');
  const sol = getSolution(bet.id, sara);
  assert.equal(sol.anchor, null);
  assert.deepEqual(sol.edges, []);
  assert.deepEqual(sol.positions, {});
  assert.equal(sol.nodes.length, 0);
  // Round-trips through JSON without inventing a blueprint key.
  const round = JSON.parse(JSON.stringify(bet));
  assert.equal('blueprint' in round, false, 'no empty blueprint key leaks into the serialized bet');
});

// --------------------------------------------------------- versioning ---------

test('versioning: the blueprint snapshots + restores through the existing mirror', () => {
  reset();
  const { betId, wf, data, agent } = seedBet();
  setBetWorkflow(betId, wf.id, sara);
  wireComponents(betId, data.id, agent.id, 'feeds', sara);
  // A plain edit snapshots the CURRENT (with-blueprint) state as a prior version.
  updateBet(betId, sara, { name: 'Reduce churn v2' });
  // Now mutate the blueprint, then restore the prior version.
  unwireComponents(betId, getSolution(betId, sara).edges[0].id, sara);
  assert.equal(getSolution(betId, sara).edges.length, 0);

  const versions = listBetVersions(betId, sara);
  const priorWithEdge = versions.find((v) => (v.state as { blueprint?: { edges: unknown[] } })?.blueprint?.edges?.length === 1);
  assert.ok(priorWithEdge, 'a version captured the blueprint with its edge');
  restoreBetVersion(betId, sara, priorWithEdge!.version);
  const sol = getSolution(betId, sara);
  assert.equal(sol.edges.length, 1, 'restore brought the edge back');
  assert.equal(sol.anchor?.id, wf.id, 'restore brought the anchor back');
});

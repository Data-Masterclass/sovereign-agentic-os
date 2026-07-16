/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Phase-3 solution WRITE route (POST) driven through the REAL handler, with
 * `requireUser` mocked. Proves each action wraps its edit-gated store setter and
 * returns the fresh blueprint: setAnchor (single-anchor + knowledge invariant),
 * attach (scaffold), wire (validate + dedupe), unwire, detach, positions — and that
 * a non-editor is rejected 403 on every write while GET stays view-scoped.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: { requireUser: async () => ACTING },
});

const { __resetBets, createBet, addComponent, getSolution } = await import('./store.ts');
const { __resetSources, __resetStrategy } = await import('./sources.ts');
import type { Actor } from './model.ts';

const sara: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

beforeEach(() => { __resetBets(); __resetSources(); __resetStrategy(); ACTING = null; });

async function loadRoute() {
  return import(`../../app/api/big-bets/[id]/solution/route.ts?${Math.random()}`);
}
async function post(id: string, body: unknown) {
  const route = await loadRoute();
  const req = new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return route.POST(req, { params: Promise.resolve({ id }) });
}
async function get(id: string) {
  const route = await loadRoute();
  return route.GET(new Request('http://x'), { params: Promise.resolve({ id }) });
}

/** A bet (owned by sara) with a knowledge ref + data ref + agent ref, all scaffolded. */
function seedBet() {
  const bet = createBet(sara, {
    name: 'Reduce churn',
    problem: { who: 'Sales', need: 'cut churn', obstacle: '', impact: '' },
    pillarId: 'pillar_retention',
    targetValue: 1_000_000,
    goLive: '2026-12-01',
  });
  const wf = addComponent(bet.id, sara, { tab: 'knowledge', scaffold: { title: 'Playbook' }, plannedReady: '2026-06-01' }).ref;
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn mart' }, plannedReady: '2026-07-01' }).ref;
  const agent = addComponent(bet.id, sara, { tab: 'agent', scaffold: { title: 'Retention agent' }, plannedReady: '2026-08-01' }).ref;
  return { betId: bet.id, wf, data, agent };
}

test('setAnchor sets the knowledge ref as anchor and returns the fresh blueprint', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId, wf } = seedBet();
  const res = await post(betId, { action: 'setAnchor', refId: wf.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.anchor?.id, wf.id, 'route returns the blueprint with the anchor set');
  // Clear it.
  const cleared = await (await post(betId, { action: 'setAnchor' })).json();
  assert.equal(cleared.anchor, null, 'empty refId clears the anchor');
});

test('setAnchor rejects a non-knowledge ref with 400 (the store invariant)', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId, data } = seedBet();
  const res = await post(betId, { action: 'setAnchor', refId: data.id });
  assert.equal(res.status, 400);
});

test('wire validates relation + refs, dedupes, and unwire removes by id', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId, data, agent } = seedBet();

  // Invalid relation → 400.
  assert.equal((await post(betId, { action: 'wire', from: data.id, to: agent.id, relation: 'bogus' })).status, 400);
  // Unknown ref → 404.
  assert.equal((await post(betId, { action: 'wire', from: 'nope', to: agent.id, relation: 'feeds' })).status, 404);

  const wired = await post(betId, { action: 'wire', from: data.id, to: agent.id, relation: 'feeds' });
  assert.equal(wired.status, 200);
  const body = await wired.json();
  assert.equal(body.edges.length, 1);
  const edgeId = body.edges[0].id;

  // Duplicate → 409.
  assert.equal((await post(betId, { action: 'wire', from: data.id, to: agent.id, relation: 'feeds' })).status, 409);

  const unwired = await (await post(betId, { action: 'unwire', edgeId })).json();
  assert.equal(unwired.edges.length, 0, 'unwire dropped the edge');
});

test('attach (scaffold) adds a component; detach removes it; positions persist', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId } = seedBet();
  const attached = await (await post(betId, { action: 'attach', kind: 'dashboard', scaffold: { title: 'Exec view' }, plannedReady: '2026-09-01' })).json();
  const dash = attached.nodes.find((n: { tab: string }) => n.tab === 'dashboard');
  assert.ok(dash, 'attach scaffolded a dashboard node onto the bet');

  const positioned = await (await post(betId, { action: 'positions', positions: { [dash.id]: { x: 5, y: 9 } } })).json();
  assert.deepEqual(positioned.positions[dash.id], { x: 5, y: 9 });

  const detached = await (await post(betId, { action: 'detach', refId: dash.id })).json();
  assert.equal(detached.nodes.find((n: { id: string }) => n.id === dash.id), undefined, 'detach removed the ref');
});

test('EDIT-GATE: a non-editor (other domain, non-member) is rejected 403 on writes but GET is also scoped', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId, wf } = seedBet();

  // Switch identity to an outsider: another domain, not a member of the bet.
  ACTING = { id: 'mo', name: 'Mo', domains: ['ops'], role: 'creator' };
  assert.equal((await post(betId, { action: 'setAnchor', refId: wf.id })).status, 403, 'write is edit-gated');
  assert.equal((await get(betId)).status, 403, 'GET is view-gated for an outsider too');

  // The owner can still read it (and nothing leaked).
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const ok = await get(betId);
  assert.equal(ok.status, 200);
  // And the store never got mutated by the rejected outsider write.
  assert.equal(getSolution(betId, sara).anchor, null);
});

test('unknown action → 400', async () => {
  ACTING = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
  const { betId } = seedBet();
  assert.equal((await post(betId, { action: 'frobnicate' })).status, 400);
});

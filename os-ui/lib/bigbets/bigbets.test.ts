/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * End-to-end of the spine — the `kind` validation gate, in unit form: create a
 * "Reduce churn" bet → planner proposes + scaffolds (tagged, planned, with deps)
 * → certify the data product (status auto-flips) → model blocked until then →
 * planner CANNOT promote; a Builder can → composition shows the lineage edges →
 * value distributes + reconciles → OPA hides a not-yet-shared component from a
 * non-member → remove ≠ delete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetBets,
  addComponent,
  advanceComponent,
  auditLog,
  canViewComponentDetail,
  createBet,
  getBet,
  listBets,
  removeComponent,
  setOverride,
  updateBet,
} from './store.ts';
import { proposePlan, approvePlan, type PlanCompleter } from './planner.ts';
import { deriveBet } from './status.ts';
import { rollup } from './roadmap.ts';
import { buildComposition } from './composition.ts';
import { realizedValue, distribute } from './value.ts';
import { __resetSources, __resetStrategy, __seedStrategy, resolveArtifact, sourceFor, isReady } from './sources.ts';
import { type Actor, type BigBet, type Principal } from './model.ts';

/**
 * A deterministic assistant completer standing in for the ONE governed LLM: it
 * returns the worked "reduce churn" breakdown as the planner's JSON contract, so
 * these gate tests exercise the real proposePlan → parse → scaffold path offline.
 */
const churnCompleter: PlanCompleter = async () =>
  JSON.stringify({
    template: 'reduce-churn',
    steps: [
      { tab: 'data', title: 'Churn data product', dependsOn: [], offsetDays: 14, rationale: 'A governed churn feature mart the model trains on.' },
      { tab: 'ml', title: 'Churn risk model', dependsOn: [0], offsetDays: 35, rationale: 'Predicts churn probability; depends on the data product.' },
      { tab: 'dashboard', title: 'Churn Risk dashboard', dependsOn: [1], offsetDays: 49, rationale: 'Surfaces at-risk accounts; builds on the model.' },
      { tab: 'agent', title: 'Sales retention agent', dependsOn: [1], offsetDays: 56, rationale: 'Reaches out to at-risk accounts; builds on the model.' },
    ],
  });
const churnPlan = () => proposePlan('Reduce churn', { complete: churnCompleter });

const sara: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };
const amir: Principal = { id: 'amir', domains: ['marketing'], role: 'creator' }; // non-member, other domain
const arya: Actor = { id: 'arya', domains: ['sales'], role: 'admin', kind: 'human' };

function reset() {
  __resetBets();
  __resetSources();
  __resetStrategy();
  // The strategy up-link ships EMPTY now; inject the NRR metric + Retention
  // pillar the churn bet measures against (RLS: sara full slice, kenji less).
  __seedStrategy(
    {
      id: 'metric_nrr',
      name: 'Net Revenue Retention',
      cubeMeasure: 'mart_retention.nrr_eur',
      unit: '€',
      baseline: 1_200_000,
      current: 1_560_000,
      rls: { sara: 1_560_000, kenji: 980_000 },
    },
    { id: 'pillar_retention', name: 'Retention', scope: 'tenant', metricId: 'metric_nrr' },
  );
}

function newChurnBet() {
  return createBet(sara, {
    name: 'Reduce churn',
    problem: { who: 'Sales reps', need: 'retain at-risk accounts', obstacle: 'no early churn signal', impact: '€360k ARR at risk/yr' },
    pillarId: 'pillar_retention',
    metricId: 'metric_nrr',
    targetValue: 400_000,
    goLive: '2026-09-01',
  });
}

test('gate: planner proposes + scaffolds a churn breakdown, all tagged + planned', async () => {
  reset();
  const bet = newChurnBet();
  const plan = await churnPlan();
  assert.equal(plan.template, 'reduce-churn');
  assert.deepEqual(plan.steps.map((s) => s.tab), ['data', 'ml', 'dashboard', 'agent']);

  const result = await approvePlan(bet.id, sara, plan, { mode: 'autonomous', kickoff: '2026-07-01' });
  assert.equal(result.created.length, 4);

  const after = getBet(bet.id, sara);
  assert.equal(after.components.length, 4);
  for (const ref of after.components) {
    const art = resolveArtifact(ref.artifactId)!;
    assert.ok(art.bigBetIds.includes(bet.id), 'every scaffolded artifact is tagged to the bet');
  }
  // Every component starts planned.
  for (const s of deriveBet(after.components)) assert.equal(s.derived, 'planned');
  // The model depends on the data product (dependency wired from the plan).
  const model = after.components.find((c) => c.tab === 'ml')!;
  const data = after.components.find((c) => c.tab === 'data')!;
  assert.ok(model.dependsOn.includes(data.id));
});

test('gate: certify the data product → status auto-flips; model blocked until then', async () => {
  reset();
  const bet = newChurnBet();
  await approvePlan(bet.id, sara, await churnPlan(), { mode: 'autonomous', kickoff: '2026-07-01' });
  let b = getBet(bet.id, sara);
  const data = b.components.find((c) => c.tab === 'data')!;
  const model = b.components.find((c) => c.tab === 'ml')!;

  assert.equal(deriveBet(b.components).find((s) => s.refId === model.id)!.blocked, true);

  // Build + certify the data product through the tab's governed flow — no edit to the bet.
  advanceComponent(bet.id, sara, data.id, 'building');
  advanceComponent(bet.id, sara, data.id, 'certified');
  b = getBet(bet.id, sara);
  assert.equal(deriveBet(b.components).find((s) => s.refId === data.id)!.derived, 'completed');
  assert.equal(deriveBet(b.components).find((s) => s.refId === model.id)!.blocked, false);
});

test('gate: the planner CANNOT promote the model; a Builder can', async () => {
  reset();
  const bet = newChurnBet();
  const res = await approvePlan(bet.id, sara, await churnPlan(), { mode: 'autonomous' });
  const model = getBet(bet.id, sara).components.find((c) => c.tab === 'ml')!;

  // A planner actor is rejected for the ready (production) transition.
  const planner: Actor = { ...sara, kind: 'planner' };
  assert.throws(() => advanceComponent(bet.id, planner, model.id, 'production'), /planner cannot/i);

  // A human Builder promotes it.
  advanceComponent(bet.id, sara, model.id, 'production');
  assert.equal(resolveArtifact(model.artifactId)!.lifecycle, 'production');
  assert.ok(isReady('production'));
  void res;
});

test('gate: composition map shows the builds-on lineage edges from real consume-edges', async () => {
  reset();
  const bet = newChurnBet();
  // Scaffold with explicit consume-edges (dashboard→model, agent→model, model→data).
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn data' }, plannedReady: '2026-07-15' }).ref;
  const model = addComponent(bet.id, sara, { tab: 'ml', scaffold: { title: 'Churn model', consumes: [data.artifactId] }, plannedReady: '2026-08-05' }).ref;
  addComponent(bet.id, sara, { tab: 'dashboard', scaffold: { title: 'Churn dash', consumes: [model.artifactId] }, plannedReady: '2026-08-20' });
  addComponent(bet.id, sara, { tab: 'agent', scaffold: { title: 'Retention agent', consumes: [model.artifactId] }, plannedReady: '2026-08-27' });

  const b = getBet(bet.id, sara);
  const map = buildComposition(b.components.map((c) => c.artifactId));
  // dashboard→model and agent→model and model→data edges are present.
  assert.ok(map.edges.some((e) => e.to === model.artifactId));
  assert.ok(map.edges.some((e) => e.to === data.artifactId));
  assert.equal(map.edges.filter((e) => e.to === model.artifactId).length, 2);
});

test('gate: OPA — a non-member, other-domain user cannot see a not-yet-shared component detail', async () => {
  reset();
  const bet = newChurnBet();
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn data' }, plannedReady: '2026-07-15' }).ref;
  const b = getBet(bet.id, sara);
  const ref = b.components.find((c) => c.id === data.id)!;
  assert.equal(canViewComponentDetail(b, ref, sara), true, 'owner/member sees it');
  assert.equal(canViewComponentDetail(b, ref, amir), false, 'non-member cannot see the draft component');
  // After it is shared/certified, a domain peer (not the bet member) could — but
  // amir is a different domain, so still no. An admin always can.
  assert.equal(canViewComponentDetail(b, ref, arya), true, 'admin sees it');
});

test('gate: remove ≠ delete — the artifact survives untagging', async () => {
  reset();
  const bet = newChurnBet();
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn data' }, plannedReady: '2026-07-15' }).ref;
  const artifactId = data.artifactId;
  removeComponent(bet.id, sara, data.id);
  assert.equal(getBet(bet.id, sara).components.length, 0, 'reference removed from the bet');
  const art = resolveArtifact(artifactId)!;
  assert.ok(art, 'artifact still exists');
  assert.equal(art.bigBetIds.includes(bet.id), false, 'just untagged');
});

test('gate: owner override is recorded BESIDE the derived state, audited', async () => {
  reset();
  const bet = newChurnBet();
  const dash = addComponent(bet.id, sara, { tab: 'dashboard', scaffold: { title: 'Churn dash' }, plannedReady: '2026-03-01' }).ref;
  sourceFor('dashboard').advance(dash.artifactId, 'draft', sara);
  setOverride(bet.id, sara, dash.id, { note: 'waiting on design', asserts: 'in-progress' });

  const b = getBet(bet.id, sara);
  const status = deriveBet(b.components).find((s) => s.refId === dash.id)!;
  assert.equal(status.derived, 'in-progress', 'derived stays authoritative');
  assert.equal(status.override!.note, 'waiting on design');
  // Roadmap shows at-risk (planned date passed) — beside the override, not replaced.
  const road = rollup(b.components, deriveBet(b.components), '2026-09-01', '2026-06-30');
  assert.equal(road.components[0].readiness, 'at-risk');
  assert.ok(auditLog(bet.id).some((e) => e.action === 'component.override'));
});

test('governance: an creator drafts a bet; a builder activates it', () => {
  reset();
  // Base role (creator) may create — but only as a DRAFT.
  const draft = createBet({ id: 'cara', domains: ['sales'], role: 'creator' }, {
    name: 'Draft bet', problem: { who: 'a', need: 'b', obstacle: 'c', impact: 'd' }, pillarId: 'pillar_retention', metricId: 'metric_nrr', targetValue: 1, goLive: '2026-09-01',
  });
  assert.equal(draft.status, 'draft');
  // A Builder creates it ACTIVE.
  const active = createBet({ id: 'bea', domains: ['sales'], role: 'builder' }, {
    name: 'Active bet', problem: { who: 'a', need: 'b', obstacle: 'c', impact: 'd' }, pillarId: 'pillar_retention', metricId: 'metric_nrr', targetValue: 1, goLive: '2026-09-01',
  });
  assert.equal(active.status, 'active');
});

test('scoping: list only returns bets the user may view', () => {
  reset();
  const bet = newChurnBet(); // sara, sales, domain-scoped
  assert.ok(listBets(sara).some((b) => b.id === bet.id));
  assert.equal(listBets(amir).some((b) => b.id === bet.id), false, 'other-domain non-member sees nothing');
  assert.ok(listBets(arya).some((b) => b.id === bet.id), 'admin sees all');
});

test('audit: detail is a Record object (not a string) — JSON.stringify is safe for UI rendering', () => {
  reset();
  const bet = newChurnBet();
  const logs = auditLog(bet.id);
  assert.ok(logs.length > 0, 'createBet writes at least one audit event');
  const withDetail = logs.filter((e) => e.detail !== undefined);
  assert.ok(withDetail.length > 0, 'bet.create event carries a detail object');
  for (const e of withDetail) {
    // detail must be a plain object — rendering it raw as a React child would crash
    // ("Objects are not valid as a React child"). The fix: JSON.stringify before render.
    assert.strictEqual(typeof e.detail, 'object', 'detail is an object, not a string');
    assert.doesNotThrow(() => JSON.stringify(e.detail), 'safe to serialize for rendering');
  }
});

test('picker: sourceFor list returns scaffolded artifacts; canView filter is domain-scoped', () => {
  reset();
  const bet = newChurnBet();
  const ref = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn data' }, plannedReady: '2026-07-15' }).ref;
  const art = resolveArtifact(ref.artifactId)!;
  assert.equal(art.visibility, 'personal', 'freshly scaffolded artifact is personal (draft)');

  // sourceFor list surfaces the artifact (the API endpoint reads this list then applies the canView filter).
  const list = sourceFor('data').list();
  assert.ok(list.some((a) => a.id === art.id), 'scaffolded artifact appears in sourceFor list');

  // The API-level canView predicate (replicated here):
  const canSee = (domains: string[], role: string) =>
    role === 'admin' || art.visibility !== 'personal' || domains.includes(art.domain);

  assert.ok(canSee(sara.domains, sara.role), 'same-domain builder sees their own personal artifact');
  assert.ok(!canSee(amir.domains, amir.role), 'other-domain non-admin cannot see a personal artifact');
  assert.ok(canSee(arya.domains, arya.role), 'admin sees all');

  // Attaching by resolved id re-resolves through tag(), confirming server-side id authority.
  const linked = sourceFor('data').tag(art.id, bet.id);
  assert.ok(linked, 'tag() returns the artifact');
  assert.ok(linked!.bigBetIds.includes(bet.id), 'bet id is recorded on the artifact after link');
});

test('updateBet: editing core fields persists and is audited', () => {
  reset();
  const bet = newChurnBet();
  const updated = updateBet(bet.id, sara, {
    name: 'Reduce enterprise churn',
    solution: 'Churn propensity ML model',
    targetValue: 500_000,
    goLive: '2026-10-01',
    ownerDeclaredValue: 420_000,
  });
  assert.equal(updated.name, 'Reduce enterprise churn');
  assert.equal(updated.solution, 'Churn propensity ML model');
  assert.equal(updated.targetValue, 500_000);
  assert.equal(updated.ownerDeclaredValue, 420_000);
  const log = auditLog(bet.id);
  assert.ok(log.some(e => e.action === 'bet.update'), 'update is audited');
});

test('gate: a non-owner cannot edit the bet (updateBet → 403)', () => {
  reset();
  const bet = newChurnBet(); // sara owns
  assert.throws(() => updateBet(bet.id, amir, { name: 'hijack' }), /Not permitted to edit/);
});

test('gate: a creator cannot advance a component to a ready verb (human-ships needs Builder+)', () => {
  reset();
  const bet = newChurnBet();
  const data = addComponent(bet.id, sara, { tab: 'data', scaffold: { title: 'Churn data' }, plannedReady: '2026-07-15' }).ref;
  const cara: Actor = { id: 'cara', domains: ['sales'], role: 'creator', kind: 'human' };
  assert.throws(() => advanceComponent(bet.id, cara, data.id, 'certified'), /Builder or Admin/);
});

test('gate: a cross-domain bet cannot be edited by a non-admin', () => {
  reset();
  const bet = createBet(arya, {
    name: 'Cross-domain bet',
    problem: { who: 'Ops', need: 'shared outcome', obstacle: 'silos', impact: 'slow' },
    pillarId: 'pillar_retention', metricId: 'metric_nrr', targetValue: 100_000, goLive: '2026-09-01',
    crossDomain: true,
  });
  assert.throws(() => updateBet(bet.id, sara, { name: 'nope' }), /Not permitted to edit/);
});

test('gate: PATCH whitelist blocks mass-assignment + creator self-activation', () => {
  reset();
  const cara: Principal = { id: 'cara', domains: ['sales'], role: 'creator' };
  const draft = createBet(cara, {
    name: 'Cara draft',
    problem: { who: 'Cara', need: 'x', obstacle: 'y', impact: 'z' },
    pillarId: 'pillar_retention', metricId: 'metric_nrr', targetValue: 1, goLive: '2026-09-01',
  });
  assert.equal(draft.status, 'draft');
  // A Creator may draft + archive their own bet, but NEVER self-activate it.
  assert.throws(() => updateBet(draft.id, cara, { status: 'active' }), /Builder or Admin/);
  // Escalation keys are silently stripped; only the whitelisted `name` lands.
  const evil: Partial<BigBet> = { owner: 'mallory', domain: 'finance', crossDomain: true, id: 'evil', name: 'renamed' };
  updateBet(draft.id, cara, evil);
  const after = getBet(draft.id, cara);
  assert.equal(after.owner, 'cara', 'owner is immutable via PATCH');
  assert.equal(after.domain, 'sales', 'domain is immutable via PATCH');
  assert.equal(after.crossDomain, false, 'crossDomain is immutable via PATCH');
  assert.equal(after.id, draft.id, 'id is immutable via PATCH');
  assert.equal(after.status, 'draft', 'still a draft — no self-activation slipped through');
  assert.equal(after.name, 'renamed', 'the whitelisted field applied');
  // A non-finite target is rejected outright (no €NaN for viewers).
  assert.throws(() => updateBet(draft.id, cara, { targetValue: Number('abc') }), /finite number/);
});

test('value end-to-end: realized distributes to components and reconciles to the bet', async () => {
  reset();
  const bet = newChurnBet();
  await approvePlan(bet.id, sara, await churnPlan(), { mode: 'autonomous' });
  const b = getBet(bet.id, sara);
  const realized = realizedValue(b, 'sara').realized; // uplift default = 360k
  const refs = b.components.map((c) => ({ refId: c.id, artifactId: c.artifactId }));
  const weights = new Map(b.components.map((c) => [c.id, 25]));
  const comp = buildComposition(refs.map((r) => r.artifactId));
  const dist = distribute(realized, refs, weights, 'manual', comp);
  assert.ok(dist.reconciles, `shares sum back to the bet (residual ${dist.residual})`);
  assert.equal(dist.betValue, 360_000);
});

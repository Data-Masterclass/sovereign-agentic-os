/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPillar, listPillars, __resetForTests as resetPillars } from '../strategy/pillars.ts';
import type { PillarScope } from '../strategy/model.ts';
import { createBet, listBets, __resetBets as resetBets } from '../bigbets/store.ts';
import { pillarPlanId, bigBetPlanId } from './plan-grants.ts';

/**
 * The `…/grants/available?kind=strategy|big-bets` feeds must return exactly the plan
 * targets the caller may VIEW — the SAME RLS/DLS listing the Strategy and Big Bets tabs
 * use (`listPillars` / `listBets`) — encoded as `pillar:<id>` / `bigbet:<id>` and bucketed
 * My/Domain/Company. These tests exercise those exact store listings + the route's
 * scope-bucket mapping, proving nothing the caller can't see is ever offered.
 */

// The route's Strategy transform: RLS-scoped pillar → encoded plan item + scope bucket.
function pillarScopeBucket(scope: PillarScope): 'personal' | 'domain' | 'marketplace' {
  if (scope === 'personal') return 'personal';
  if (scope === 'tenant') return 'marketplace';
  return 'domain';
}
function strategyItems(pillars: { id: string; name: string; scope: PillarScope }[]) {
  return pillars.map((p) => ({ id: pillarPlanId(p.id), name: p.name, scope: pillarScopeBucket(p.scope) }));
}
// The route's Big-Bets transform: canView-scoped bet → encoded plan item + scope bucket.
function betItems(bets: { id: string; name: string; owner: string; crossDomain: boolean }[], viewerId: string) {
  return bets.map((b) => ({
    id: bigBetPlanId(b.id),
    name: b.name,
    scope: b.owner === viewerId ? ('personal' as const) : b.crossDomain ? ('marketplace' as const) : ('domain' as const),
  }));
}

const sales = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'builder' as const };
const salesAdmin = { id: 'root', name: 'Root', domains: ['sales', 'finance'], role: 'admin' as const };
const finance = { id: 'kenji', name: 'Kenji', domains: ['finance'], role: 'builder' as const };

test('STRATEGY feed: caller sees own My pillar + domain + company; never a foreign domain pillar', async () => {
  resetPillars();
  const mine = await createPillar(sales, { name: 'Sales North Star', scope: 'personal', domain: 'sales' });
  const domainP = await createPillar(sales, { name: 'Sales Domain Pillar', scope: 'domain', domain: 'sales' });
  const companyP = await createPillar(salesAdmin, { name: 'Company Pillar', scope: 'tenant' });
  const foreign = await createPillar(finance, { name: 'Finance Secret Pillar', scope: 'domain', domain: 'finance' });

  const items = strategyItems(await listPillars(sales));
  const byId = new Map(items.map((i) => [i.id, i]));

  assert.equal(byId.get(pillarPlanId(mine.id))?.scope, 'personal');
  assert.equal(byId.get(pillarPlanId(domainP.id))?.scope, 'domain');
  assert.equal(byId.get(pillarPlanId(companyP.id))?.scope, 'marketplace'); // Company tier
  assert.ok(!byId.has(pillarPlanId(foreign.id)), "another domain's pillar must NEVER leak");
  // Ids are the encoded plan grant ids, names are human titles.
  assert.equal(byId.get(pillarPlanId(mine.id))?.name, 'Sales North Star');
});

test('BIG-BETS feed: caller sees own bets (My) + domain bets; a foreign-domain bet does not leak', () => {
  resetBets();
  resetPillars();
  const pillarId = 'pillar:test'; // createBet only requires a non-empty pillarId
  const problem = { who: 'ops', need: 'faster', obstacle: '', impact: '' };

  const mine = createBet(sales, { name: 'My Bet', problem, pillarId, targetValue: 1, goLive: '2026-12-01', domain: 'sales' });
  // A domain peer's bet in sales — a domain-scoped bet's summary is visible to sales peers.
  const salesPeer = { id: 'bea', domains: ['sales'], role: 'builder' as const };
  const peerBet = createBet(salesPeer, { name: 'Peer Bet', problem, pillarId, targetValue: 1, goLive: '2026-12-01', domain: 'sales' });
  // A finance bet — must NOT surface to a sales-only viewer.
  const foreign = createBet(finance, { name: 'Finance Bet', problem, pillarId, targetValue: 1, goLive: '2026-12-01', domain: 'finance' });

  const items = betItems(listBets(sales), sales.id);
  const byId = new Map(items.map((i) => [i.id, i]));

  assert.equal(byId.get(bigBetPlanId(mine.id))?.scope, 'personal', 'own bet → My');
  assert.equal(byId.get(bigBetPlanId(peerBet.id))?.scope, 'domain', "peer's domain bet → Domain");
  assert.ok(!byId.has(bigBetPlanId(foreign.id)), "another domain's bet must NEVER leak");
});

test('BIG-BETS feed: an Admin cross-domain bet buckets as Company for a non-owner viewer', () => {
  resetBets();
  const pillarId = 'pillar:test';
  const problem = { who: 'ops', need: 'faster', obstacle: '', impact: '' };
  // Admin-owned cross-domain bet (spanning sales + finance).
  const xbet = createBet(salesAdmin, {
    name: 'Cross Bet', problem, pillarId, targetValue: 1, goLive: '2026-12-01', domain: 'sales', crossDomain: true,
  });

  // The admin owns it → My for them; but Admin can view all, so bucket by owner/reach.
  const adminItems = betItems(listBets(salesAdmin), salesAdmin.id);
  assert.equal(adminItems.find((i) => i.id === bigBetPlanId(xbet.id))?.scope, 'personal');

  // Admin members always include the owner; add sales user as a member so they can view it.
  // (A non-member, non-admin cannot view a cross-domain bet — canView fails closed.)
  const salesMember = { id: 'amir', domains: ['sales'], role: 'builder' as const };
  const xbet2 = createBet(salesAdmin, {
    name: 'Cross Bet 2', problem, pillarId, targetValue: 1, goLive: '2026-12-01', domain: 'sales', crossDomain: true,
    members: ['amir'],
  });
  const memberItems = betItems(listBets(salesMember), salesMember.id);
  assert.equal(memberItems.find((i) => i.id === bigBetPlanId(xbet2.id))?.scope, 'marketplace', 'cross-domain bet → Company for a non-owner');
});

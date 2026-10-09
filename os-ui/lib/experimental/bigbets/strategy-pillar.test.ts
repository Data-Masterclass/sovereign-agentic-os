/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Verifies Fix 1: /api/big-bets/strategy reads the REAL strategy store.
 *
 * Tests exercise:
 *   1. Sources adapter: listPillars()/getPillar() from sources.ts delegates to
 *      globalThis strategy cache when present (not phantom Maps).
 *   2. Bet creation accepts a real pillarId (no validation → just passes through).
 *   3. canCreatePillar gate: creator cannot create strategy pillars (403 from
 *      lib/strategy/pillars.ts createPillar).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  listPillars as sourceListPillars,
  getPillar as sourceGetPillar,
  __resetStrategy,
  __seedStrategy,
} from './sources.ts';
import { createBet, _getBetRaw, _setPillarId, __resetBets } from './store.ts';
import { __resetSources } from './sources.ts';
import {
  createPillar,
  linkBet as pillarLinkBet,
  unlinkBet as pillarUnlinkBet,
  listPillars as stratListPillars,
  __resetForTests,
} from '../strategy/pillars.ts';
import { canCreatePillar } from '../strategy/model.ts';
import type { Principal } from './model.ts';

const builder: Parameters<typeof createPillar>[0] = {
  id: 'test-builder',
  name: 'Test Builder',
  role: 'builder',
  domains: ['sales'],
};
const creator: Parameters<typeof createPillar>[0] = {
  id: 'test-creator',
  name: 'Test Creator',
  role: 'creator',
  domains: ['sales'],
};
const betBuilder: Principal = { id: 'test-builder', domains: ['sales'], role: 'builder' };

function resetAll() {
  __resetBets();
  __resetSources();
  __resetStrategy();
  __resetForTests();
}

// ------------------------------------------------------------------
// 1. Sources adapter: globalThis takes precedence over phantom Maps
// ------------------------------------------------------------------

test('sources.ts listPillars delegates to the real strategy cache when present', async () => {
  resetAll();

  // Seed via the REAL strategy store (same path as POST /api/strategy/pillars).
  const p = await createPillar(builder, { name: 'Retention', scope: 'domain' });

  // The sources adapter reads globalThis → finds the pillar.
  const list = sourceListPillars();
  assert.ok(list.some((x) => x.id === p.id), 'sources.listPillars must surface pillar from real store');
  assert.equal(list.find((x) => x.id === p.id)?.name, 'Retention');
});

test('sources.ts getPillar delegates to the real strategy cache', async () => {
  resetAll();
  // builder can create domain pillars in their own domain ('sales')
  const p = await createPillar(builder, { name: 'Efficiency', scope: 'domain', domain: 'sales' });
  const found = sourceGetPillar(p.id);
  assert.ok(found, 'getPillar must resolve a real-store pillar by id');
  assert.equal(found?.name, 'Efficiency');
});

test('sources.ts listPillars falls back to phantom when real cache is empty', () => {
  resetAll();
  // Real cache is empty (no strategy routes ran, __resetForTests cleared it).
  // Seed via phantom __seedStrategy hook.
  __seedStrategy(undefined, { id: 'pillar_phantom', name: 'Phantom', scope: 'tenant', domain: 'tenant', metricId: 'metric_x' });
  const list = sourceListPillars();
  assert.ok(list.some((x) => x.id === 'pillar_phantom'), 'phantom fallback must work when real cache absent');
});

// ------------------------------------------------------------------
// 2. Bet creation requires a pillarId; the store stores it as given
//    (pillar existence is validated at the API/MCP layer, not the store).
// ------------------------------------------------------------------

test('createBet stores any pillarId without pillar-existence check in the store', async () => {
  resetAll();
  const p = await createPillar(builder, { name: 'Growth', scope: 'domain' });

  const bet = createBet(betBuilder, {
    name: 'Grow DACH',
    problem: { who: 'Sales', need: 'Grow DACH', obstacle: '', impact: '' },
    pillarId: p.id,   // real pillar id from the strategy store
    metricId: '',
    targetValue: 500_000,
    goLive: '2026-12-31',
  });
  assert.equal(bet.pillarId, p.id, 'bet stores the real pillarId');
});

// ------------------------------------------------------------------
// 3. canCreatePillar gate: creator is always 403 server-side
// ------------------------------------------------------------------

test('canCreatePillar returns false for a creator (any scope)', () => {
  // Pure logic gate from strategy/model.ts — no async needed.
  assert.equal(canCreatePillar(creator, 'tenant', 'tenant'), false, 'creator cannot create tenant pillar');
  assert.equal(canCreatePillar(creator, 'domain', 'sales'), false, 'creator cannot create domain pillar');
});

test('canCreatePillar returns true for a builder in their own domain', () => {
  assert.equal(canCreatePillar(builder, 'domain', 'sales'), true, 'builder can create domain pillar in their domain');
  assert.equal(canCreatePillar(builder, 'domain', 'other'), false, 'builder cannot create pillar in a domain they don\'t own');
  assert.equal(canCreatePillar(builder, 'tenant', 'tenant'), false, 'builder cannot create tenant pillar');
});

test('createPillar throws 403 when called by a creator', async () => {
  resetAll();
  await assert.rejects(
    () => createPillar(creator, { name: 'Sneaky pillar', scope: 'domain' }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 403, 'must be 403');
      return true;
    },
    'creator calling createPillar must be rejected with 403',
  );
});

// ------------------------------------------------------------------
// 4. Strategy store cross-route singleton check (belt-and-suspenders)
// ------------------------------------------------------------------

test('pillar created via strategy store is immediately visible via sources adapter', async () => {
  resetAll();
  const p = await createPillar(builder, { name: 'CrossRouteCheck', scope: 'domain' });

  // Simulate "route A wrote, route B reads" — both share globalThis.
  const viaStrategy = await stratListPillars(builder);
  const viaSources = sourceListPillars();

  assert.ok(viaStrategy.some((x) => x.id === p.id), 'strategy listPillars sees new pillar');
  assert.ok(viaSources.some((x) => x.id === p.id), 'sources adapter also sees it via globalThis');
});

// ------------------------------------------------------------------
// 5. Pillar ↔ bet backlink: linkBet keeps betIds + bet.pillarId in sync
// ------------------------------------------------------------------

test('linkBet adds betId to pillar.betIds AND stamps bet.pillarId (two-way index)', async () => {
  resetAll();
  const p = await createPillar(builder, { name: 'Backlink Pillar', scope: 'domain' });
  const pOther = await createPillar(builder, { name: 'Other Pillar', scope: 'domain' });

  // Create a real bet under a DIFFERENT pillar, then re-link it to p (simulates a
  // pillar-move scenario — the most realistic test of the two-way index).
  const bet = createBet(betBuilder, {
    name: 'Backlink Bet',
    problem: { who: 'Sales', need: 'Grow NRR', obstacle: '', impact: '' },
    pillarId: pOther.id,
    targetValue: 300_000,
    goLive: '2026-12-31',
  });

  // Before linking to p: p.betIds is empty; bet is under pOther (not p).
  const pillarBefore = (await stratListPillars(builder)).find((x) => x.id === p.id)!;
  assert.equal(pillarBefore.betIds.length, 0, 'pillar.betIds is empty before link');
  // The bet has a pillarId from creation but it is NOT p yet — use _setPillarId to
  // clear it so we can test the "unlinked → linked" transition the same way.
  // (This mirrors a migrated/grandfathered bet that has no current pillar assignment.)
  _setPillarId(bet.id, undefined);
  assert.equal(_getBetRaw(bet.id)?.pillarId, undefined, 'bet.pillarId is unset before link');

  // Link bet → pillar via the governed path.
  const pillarAfter = await pillarLinkBet(builder, p.id, bet.id);

  // Pillar's betIds now includes the bet.
  assert.ok(pillarAfter.betIds.includes(bet.id), 'pillar.betIds includes the bet after link');

  // Bet's pillarId is now set to the pillar's id (the backlink).
  assert.equal(_getBetRaw(bet.id)?.pillarId, p.id, 'bet.pillarId is stamped to the pillar after link');
});

test('unlinkBet removes betId from pillar.betIds AND clears bet.pillarId', async () => {
  resetAll();
  const p = await createPillar(builder, { name: 'Unlink Pillar', scope: 'domain' });
  const bet = createBet(betBuilder, {
    name: 'Unlink Bet',
    problem: { who: 'Sales', need: 'Cost savings', obstacle: '', impact: '' },
    pillarId: p.id,
    targetValue: 100_000,
    goLive: '2026-12-31',
  });

  await pillarLinkBet(builder, p.id, bet.id);
  assert.ok((await stratListPillars(builder)).find((x) => x.id === p.id)?.betIds.includes(bet.id), 'linked');

  // Unlink.
  const pillarAfterUnlink = await pillarUnlinkBet(builder, p.id, bet.id);
  assert.equal(pillarAfterUnlink.betIds.includes(bet.id), false, 'pillar.betIds no longer includes the bet');
  assert.equal(_getBetRaw(bet.id)?.pillarId, undefined, 'bet.pillarId is cleared after unlink');
});

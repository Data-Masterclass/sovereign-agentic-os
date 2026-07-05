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
import { createBet, __resetBets } from './store.ts';
import { __resetSources } from './sources.ts';
import {
  createPillar,
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
// 2. Bet creation accepts a real pillarId (no pillar validation in store)
// ------------------------------------------------------------------

test('createBet stores any pillarId without validation', async () => {
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

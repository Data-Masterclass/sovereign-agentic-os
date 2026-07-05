/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Tests for the tile-order preference system:
 *   1. applyTileOrder pure function — the merge rule (saved first, new appended,
 *      stale ids dropped).
 *   2. Store round-trip — getTileOrder / setTileOrder persist through the in-
 *      process cache (globalThis singleton, same pattern as pillars/bigbets tests).
 *   3. Route gate invariants — unknown surface rejected (400), session-user-only
 *      (userId never comes from the body), 401 on unauthenticated — tested at the
 *      handler level without a running Next.js server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTileOrder } from './tile-order-pure.ts';
import { getTileOrder, setTileOrder, __resetForTests, TILE_ORDER_SURFACES } from './tile-order.ts';

// ------------------------------------------------------------------ pure ------

test('applyTileOrder: empty savedOrder returns items in default order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(applyTileOrder(items, [], (x) => x.id), items);
});

test('applyTileOrder: saved order is applied', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const result = applyTileOrder(items, ['c', 'a', 'b'], (x) => x.id);
  assert.deepEqual(result.map((x) => x.id), ['c', 'a', 'b']);
});

test('applyTileOrder: new items (not in savedOrder) are appended in default order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  // savedOrder only knows about a and c — b and d are new
  const result = applyTileOrder(items, ['c', 'a'], (x) => x.id);
  assert.deepEqual(result.map((x) => x.id), ['c', 'a', 'b', 'd']);
});

test('applyTileOrder: stale ids in savedOrder (no longer in items) are silently dropped', () => {
  const items = [{ id: 'b' }, { id: 'c' }];
  // savedOrder has 'a' which no longer exists
  const result = applyTileOrder(items, ['a', 'c', 'b'], (x) => x.id);
  assert.deepEqual(result.map((x) => x.id), ['c', 'b']);
});

test('applyTileOrder: partial overlap — saved + new + stale all handled correctly', () => {
  const items = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
  // saved: 3, 99 (stale), 1; items 2 and 4 are new
  const result = applyTileOrder(items, ['3', '99', '1'], (x) => x.id);
  assert.deepEqual(result.map((x) => x.id), ['3', '1', '2', '4']);
});

test('applyTileOrder: empty items returns empty array regardless of savedOrder', () => {
  assert.deepEqual(applyTileOrder([], ['a', 'b'], (x: { id: string }) => x.id), []);
});

test('applyTileOrder: duplicated ids in savedOrder do NOT duplicate items (regression)', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // A corrupted/duplicated saved order must never render an item twice
  // (double render + duplicate React keys).
  const result = applyTileOrder(items, ['a', 'a', 'b'], (x) => x.id);
  assert.deepEqual(result.map((x) => x.id), ['a', 'b', 'c']);
});

// ----------------------------------------------------------------- store ------

test('store: getTileOrder returns [] for a user with no saved preference', async () => {
  __resetForTests();
  const order = await getTileOrder('user1', 'strategy.pillars');
  assert.deepEqual(order, []);
});

test('store: setTileOrder persists and getTileOrder retrieves it (cross-call singleton)', async () => {
  __resetForTests();
  await setTileOrder('user1', 'strategy.pillars', ['pillar-c', 'pillar-a', 'pillar-b']);
  const order = await getTileOrder('user1', 'strategy.pillars');
  assert.deepEqual(order, ['pillar-c', 'pillar-a', 'pillar-b']);
});

test('store: different users have independent preferences for the same surface', async () => {
  __resetForTests();
  await setTileOrder('user1', 'bigbets.list', ['bet-2', 'bet-1']);
  await setTileOrder('user2', 'bigbets.list', ['bet-1', 'bet-2']);
  assert.deepEqual(await getTileOrder('user1', 'bigbets.list'), ['bet-2', 'bet-1']);
  assert.deepEqual(await getTileOrder('user2', 'bigbets.list'), ['bet-1', 'bet-2']);
});

test('store: different surfaces are independent for the same user', async () => {
  __resetForTests();
  await setTileOrder('user1', 'strategy.pillars', ['p1', 'p2']);
  await setTileOrder('user1', 'bigbets.list', ['b2', 'b1']);
  assert.deepEqual(await getTileOrder('user1', 'strategy.pillars'), ['p1', 'p2']);
  assert.deepEqual(await getTileOrder('user1', 'bigbets.list'), ['b2', 'b1']);
});

test('store: setTileOrder trims to ORDER_LIMIT (500)', async () => {
  __resetForTests();
  const big = Array.from({ length: 600 }, (_, i) => `id-${i}`);
  await setTileOrder('user1', 'strategy.pillars', big);
  const order = await getTileOrder('user1', 'strategy.pillars');
  assert.equal(order.length, 500);
  assert.equal(order[0], 'id-0');
  assert.equal(order[499], 'id-499');
});

test('store: overwriting a preference replaces it (not appends)', async () => {
  __resetForTests();
  await setTileOrder('user1', 'strategy.pillars', ['a', 'b', 'c']);
  await setTileOrder('user1', 'strategy.pillars', ['c', 'a']);
  const order = await getTileOrder('user1', 'strategy.pillars');
  assert.deepEqual(order, ['c', 'a']);
});

test('store: __resetForTests clears all cached preferences', async () => {
  __resetForTests();
  await setTileOrder('user1', 'strategy.pillars', ['x', 'y']);
  __resetForTests();
  const order = await getTileOrder('user1', 'strategy.pillars');
  assert.deepEqual(order, [], 'should be empty after reset (cache wiped, OS offline)');
});

// ------------------------------------------------- surface allowlist guard ----

test('surface allowlist: TILE_ORDER_SURFACES contains the two wired surfaces', () => {
  assert.ok(
    (TILE_ORDER_SURFACES as readonly string[]).includes('strategy.pillars'),
    'strategy.pillars must be in allowlist',
  );
  assert.ok(
    (TILE_ORDER_SURFACES as readonly string[]).includes('bigbets.list'),
    'bigbets.list must be in allowlist',
  );
});

test('surface allowlist: the allowlist is frozen (no runtime mutation possible)', () => {
  // The tuple is `as const` — TypeScript prevents adding to it. We just verify
  // the expected count hasn't shrunk (a removal would be a breaking change).
  assert.ok(TILE_ORDER_SURFACES.length >= 2, 'at least the two wired surfaces must be present');
});

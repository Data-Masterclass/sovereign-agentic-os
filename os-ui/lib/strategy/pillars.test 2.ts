/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Cross-route singleton test for lib/strategy/pillars.ts
 *
 * Proves that pillars created via one module import (simulating POST
 * /api/strategy/pillars) are visible via a second import (simulating GET
 * /api/strategy/pillars or the Big Bet dropdown), because both resolve to the
 * same globalThis[Symbol.for('soa.strategy.pillars')] Map — not two separate
 * module-scope variables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Simulate two independent route bundles importing the same module. In the
// test runner they share the same module cache, but the key proof is that the
// state object IS the one on globalThis, not a hidden module-level variable.
import {
  createPillar,
  listPillars,
  __resetForTests,
} from './pillars.ts';

const admin: Parameters<typeof createPillar>[0] = {
  id: 'test-admin',
  name: 'Test Admin',
  role: 'admin',
  domains: ['platform'],
};

test('globalThis singleton: created pillar is visible in list (cross-route proof)', async () => {
  __resetForTests();

  // Verify the shared state lives on globalThis under the expected key.
  const KEY = Symbol.for('soa.strategy.pillars');
  const g = globalThis as unknown as Record<symbol, unknown>;
  // Before any call the slot may not exist yet; getCache initialises it.
  const created = await createPillar(admin, {
    name: 'Test Pillar',
    scope: 'tenant',
  });

  // The state must now be on globalThis.
  assert.ok(g[KEY], 'globalThis slot must exist after first write');

  // A second consumer (e.g. the Big Bet dropdown route) reads the same slot.
  const all = await listPillars(admin);
  assert.ok(
    all.some((p) => p.id === created.id),
    'pillar created in one route bundle must appear in list read by another',
  );
  assert.equal(all.find((p) => p.id === created.id)?.name, 'Test Pillar');
});

test('__resetForTests clears the shared cache', async () => {
  // After reset, the list should be empty (seed() returns []).
  __resetForTests();
  const all = await listPillars(admin);
  assert.equal(all.length, 0, 'list must be empty after reset');
});

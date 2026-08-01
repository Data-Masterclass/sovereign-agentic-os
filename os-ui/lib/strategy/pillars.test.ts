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
  renamePillar,
  movePillar,
  getPillar,
  __resetForTests,
} from './pillars.ts';

const admin: Parameters<typeof createPillar>[0] = {
  id: 'test-admin',
  name: 'Test Admin',
  role: 'admin',
  domains: ['platform'],
};

/** A plain creator in another domain — never an editor of a tenant/company pillar. */
const outsider: Parameters<typeof createPillar>[0] = {
  id: 'outsider',
  name: 'Outsider',
  role: 'creator',
  domains: ['sales'],
};

function statusOf(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

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

// -------------------------------------------------------------- rename ----------

test('renamePillar changes the DISPLAY name but the id stays FROZEN', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  const renamed = await renamePillar(admin, p.id, '  Grow NRR  ');
  assert.equal(renamed.name, 'Grow NRR', 'name is trimmed + updated');
  assert.equal(renamed.id, p.id, 'id is the frozen identity — never changes on rename');
  // Read back through a fresh get to prove the persisted state moved too.
  const reread = await getPillar(admin, p.id);
  assert.equal(reread.name, 'Grow NRR');
});

test('renamePillar rejects an empty/whitespace name with 400', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  await assert.rejects(
    () => renamePillar(admin, p.id, '   '),
    (e) => statusOf(e) === 400,
    'blank name → 400',
  );
});

test('renamePillar is edit-scoped — an unauthorized caller gets 403', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  await assert.rejects(
    () => renamePillar(outsider, p.id, 'Hijacked'),
    (e) => statusOf(e) === 403,
    'a non-editor of a Company pillar cannot rename it',
  );
});

test('renamePillar is a no-op (no throw) when the name is unchanged', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  const same = await renamePillar(admin, p.id, 'Retention');
  assert.equal(same.name, 'Retention');
  assert.equal(same.id, p.id);
});

// --------------------------------------------------------------- move -----------

test('movePillar sets the folder + the placement survives a re-read', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  assert.equal(p.folder, '/', 'a fresh pillar lives at the root');
  const moved = await movePillar(admin, p.id, '/north-star');
  assert.equal(moved.folder, '/north-star');
  const reread = await getPillar(admin, p.id);
  assert.equal(reread.folder, '/north-star', 'the folder placement persisted');
});

test('movePillar is edit-scoped — an unauthorized caller gets 403', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  await assert.rejects(
    () => movePillar(outsider, p.id, '/somewhere'),
    (e) => statusOf(e) === 403,
    'a non-editor cannot move a Company pillar',
  );
});

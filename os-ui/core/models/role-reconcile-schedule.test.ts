/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The boot wiring of the role mapping: the first mapping is retried, and the gateway follows at once.
 * USER STORY: As an operator on a first boot where the catalog read times out, the retry writes the mapping and the
 *             role aliases are set at the gateway right after — and an admin's mapping made meanwhile stops the retries.
 * ARCHITECTURE: `scheduleRoleReconcile` with an in-memory gateway and file, an instant `sleep`, and a timer interval
 *   long enough never to fire: it proves `mapped: roleMappingActive`, a reconcile pass after attempt 1 and after the
 *   success (and none in between), and the boot-once guard.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleRoleReconcile, reconcileRoleMapping, type RoleReconcileIo } from '@core/models/role-reconcile';
import { roleSeedStatus, resetRoleSeedStatus, type SeedAttemptResult } from '@core/models/role-seed-retry';
import type { RoleMapping } from '@core/models/role-mapping';

const MAPPING: RoleMapping = { 'sovereign-strong': 'stackit-qwen3-vl-235b', 'sovereign-worker': 'stackit-gpt-oss-20b', 'sovereign-embedding': 'stackit-embed' };
const CATALOG = Object.values(MAPPING);

function world() {
  const s = { file: null as RoleMapping | null, aliases: {} as Record<string, string>, aliasWrites: 0, passes: 0 };
  const io: RoleReconcileIo = {
    readMapping: async () => s.file,
    writeMapping: async (m) => { s.file = m; return { sha: 'c1', changed: true }; },
    readRevision: async () => (s.file ? 'r-mapped' : 'r0'),
    catalog: async () => ({ ok: true, data: CATALOG }),
    readAliases: async () => ({ ok: true, data: { ...s.aliases } }),
    writeAliases: async (a) => { s.aliases = { ...a }; s.aliasWrites += 1; return { ok: true, data: {} }; },
    log: () => {},
  };
  const factory = () => { s.passes += 1; return io; };
  return { s, io, factory };
}

const quiet = { log: () => {} };
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), 'condition reached');
}

beforeEach(() => {
  const g = globalThis as unknown as { __osRoleReconcileBooted?: boolean; __osRoleReport?: unknown };
  g.__osRoleReconcileBooted = false;
  g.__osRoleReport = undefined;
  resetRoleSeedStatus();
});

test('first attempt times out → a pass (unmapped); the retry seeds → a pass sets the aliases at once; boot-once guard', async () => {
  const w = world();
  let seeds = 0;
  const prepare = async (): Promise<SeedAttemptResult> => {
    seeds += 1;
    if (seeds === 1) return { state: 'unreadable', error: 'LiteLLM catalog: timeout after 2500ms' };
    w.s.file = MAPPING;
    return { state: 'seeded' };
  };
  const sleeps: number[] = [];
  const stop = scheduleRoleReconcile(w.factory, 3600, prepare, { ...quiet, sleep: async (ms) => { sleeps.push(ms); } });
  assert.ok(stop, 'scheduled');
  try {
    await until(() => roleSeedStatus()?.state === 'mapped' && w.s.aliasWrites > 0);
    assert.equal(seeds, 2);
    assert.deepEqual(sleeps, [5_000]);
    assert.equal(w.s.passes, 2, 'one pass after attempt 1, one after the success — nothing in between');
    for (const [role, model] of Object.entries(MAPPING)) assert.equal(w.s.aliases[role], model, `${role} enforced at the gateway right after the seed`);

    // Boot-once: a second schedule (e.g. a re-imported instrumentation) does nothing.
    assert.equal(scheduleRoleReconcile(w.factory, 3600, prepare, quiet), null);
    await until(() => true);
    assert.equal(seeds, 2, 'the seed is not started again');
  } finally {
    stop!();
  }
});

test('mapped: roleMappingActive — an admin mapping made meanwhile stops the retries before the next attempt', async () => {
  const w = world();
  let seeds = 0;
  const prepare = async (): Promise<SeedAttemptResult> => { seeds += 1; return { state: 'unreadable', error: 'timeout' }; };
  // While the loop waits, an admin maps the roles (an apply commits the file and reconciles: the report then carries the mapping).
  const sleep = async () => { w.s.file = MAPPING; await reconcileRoleMapping(w.io); };
  const stop = scheduleRoleReconcile(w.factory, 3600, prepare, { ...quiet, sleep });
  try {
    await until(() => roleSeedStatus()?.state === 'mapped');
    assert.equal(seeds, 1, 'no second seed attempt');
    assert.equal(roleSeedStatus()?.lastState, 'already-mapped');
    assert.equal(w.s.passes, 1, 'only the pass after attempt 1 (the admin apply reconciled itself)');
  } finally {
    stop!();
  }
});

test('interval 0 schedules nothing (and runs no seed)', () => {
  const w = world();
  let seeds = 0;
  assert.equal(scheduleRoleReconcile(w.factory, 0, async () => { seeds += 1; return { state: 'seeded' }; }, quiet), null);
  assert.equal(seeds, 0);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The first role mapping is retried with backoff until it exists; a persistent miss is a health signal.
 * USER STORY: As an operator on a first boot where LiteLLM is still busy (incident 23 Nov 2026: "LiteLLM catalog:
 *             timeout after 2500ms"), the roles map themselves on a later attempt; if they cannot, I am told.
 * ARCHITECTURE: `seedUntilMapped` with an injected seed, sleep and clock (no timers); the real seed over a fake
 *   gateway proves "timeout, then success" end to end through `seedRoleMapping`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { seedUntilMapped, roleSeedAlert, roleSeedStatus, resetRoleSeedStatus, seedRetryDelay, PERSISTENT_AFTER, SEED_RETRY_DELAYS_MS, type SeedAttemptResult } from '@core/models/role-seed-retry';
import { seedRoleMapping, type SeedIo } from '@core/models/role-seed';
import type { RoleMapping } from '@core/models/role-mapping';

const SEED: RoleMapping = { 'sovereign-strong': 'stackit-qwen3-vl-235b', 'sovereign-worker': 'stackit-gpt-oss-20b', 'sovereign-embedding': 'stackit-embed' };
const CATALOG = ['stackit-qwen3-vl-235b', 'stackit-gpt-oss-20b', 'stackit-embed'];

function harness() {
  const sleeps: number[] = [];
  const lines: { level: string; line: string }[] = [];
  let t = 1_000_000;
  return {
    sleeps,
    lines,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    now: () => t,
    log: (level: 'info' | 'warn' | 'error', line: string) => { lines.push({ level, line }); },
  };
}

beforeEach(() => resetRoleSeedStatus());

test('the incident: a catalog timeout on the first attempt is retried after 5 s, and the retry writes the mapping', async () => {
  // The real seed over a gateway that times out once, then answers.
  let catalogCalls = 0;
  const file: { m: RoleMapping | null } = { m: null };
  const io: SeedIo = {
    readMapping: async () => file.m,
    writeMapping: async (m) => { file.m = m; return { sha: 'c1', changed: true }; },
    catalog: async () => (++catalogCalls === 1 ? { ok: false, error: 'timeout after 2500ms' } : { ok: true, data: CATALOG }),
  };
  const h = harness();
  const after: [number, boolean][] = [];
  const st = await seedUntilMapped({ ...h, seed: () => seedRoleMapping(io, { seed: SEED, legacy: null }, { by: 'system:os-ui' }), afterAttempt: (n, ok) => { after.push([n, ok]); } });
  assert.equal(st.state, 'mapped');
  assert.equal(st.lastState, 'seeded');
  assert.equal(st.attempts, 2);
  assert.deepEqual(file.m, SEED, 'the mapping is written on the retry');
  assert.deepEqual(h.sleeps, [5_000]);
  assert.deepEqual(after, [[1, false], [2, true]], 'a reconcile pass follows the first attempt and the success');
  assert.ok(h.lines.some((l) => l.level === 'warn' && /attempt 1 failed \(unreadable\): LiteLLM catalog: timeout after 2500ms; next try in 5 s/.test(l.line)), 'each failure is logged');
  assert.equal(roleSeedStatus()?.state, 'mapped');
});

test('backoff: 5 s, 15 s, 30 s, 60 s, 120 s, then every 300 s — it never gives up', async () => {
  const h = harness();
  let n = 0;
  const st = await seedUntilMapped({ ...h, seed: async (): Promise<SeedAttemptResult> => (++n < 10 ? { state: 'unreadable', error: 'LiteLLM catalog: timeout' } : { state: 'seeded' }) });
  assert.equal(st.state, 'mapped');
  assert.equal(st.attempts, 10);
  assert.deepEqual(h.sleeps, [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000]);
  assert.equal(seedRetryDelay(100), SEED_RETRY_DELAYS_MS[SEED_RETRY_DELAYS_MS.length - 1]);
});

test('an incomplete catalog (models not registered yet) is retried too', async () => {
  const h = harness();
  const states = ['incomplete', 'incomplete', 'migrated'];
  const st = await seedUntilMapped({ ...h, seed: async () => ({ state: states.shift()!, error: 'no catalog model to map sovereign-embedding to' }) });
  assert.equal(st.lastState, 'migrated');
  assert.equal(st.attempts, 3);
});

test('a seed that throws is a failed attempt, not the end of the loop', async () => {
  const h = harness();
  let n = 0;
  const st = await seedUntilMapped({ ...h, seed: async () => { if (++n === 1) throw new Error('git push rejected'); return { state: 'seeded' }; } });
  assert.equal(st.state, 'mapped');
  assert.ok(h.lines.some((l) => /attempt 1 failed \(error\): git push rejected/.test(l.line)));
});

test('stops when a mapping appears meanwhile (an admin mapped the roles): no further seed attempt', async () => {
  const h = harness();
  let seeds = 0;
  let adminMapped = false;
  const st = await seedUntilMapped({
    ...h,
    mapped: () => adminMapped,
    seed: async () => { seeds += 1; return { state: 'unreadable', error: 'timeout' }; },
    sleep: async (ms) => { h.sleeps.push(ms); if (h.sleeps.length === 2) adminMapped = true; },
  });
  assert.equal(seeds, 2, 'the third attempt never runs');
  assert.equal(st.state, 'mapped');
  assert.equal(st.lastState, 'already-mapped');
  assert.equal(roleSeedAlert(st, false), null, 'nothing to raise once mapped');
});

test('a mapping that already exists stops at the first attempt (already-mapped is success)', async () => {
  const h = harness();
  const st = await seedUntilMapped({ ...h, seed: async () => ({ state: 'already-mapped' }) });
  assert.equal(st.attempts, 1);
  assert.deepEqual(h.sleeps, []);
});

test('HEALTH SIGNAL: a persistent failure raises "model roles not mapped" in Monitoring, cleared when a mapping exists', async () => {
  const h = harness();
  let n = 0;
  let snapshot: ReturnType<typeof roleSeedStatus> = null;
  await seedUntilMapped({
    ...h,
    seed: async () => (++n <= PERSISTENT_AFTER + 1 ? { state: 'unreadable', error: 'LiteLLM catalog: timeout after 12000ms' } : { state: 'seeded' }),
    afterAttempt: (attempt) => {
      if (attempt === PERSISTENT_AFTER - 1) assert.equal(roleSeedAlert(roleSeedStatus(), false), null, 'nothing raised before the threshold');
      if (attempt === PERSISTENT_AFTER) snapshot = structuredClone(roleSeedStatus());
    },
  });
  assert.equal(snapshot!.state, 'persistent');
  const a = roleSeedAlert(snapshot, false);
  assert.equal(a?.title, 'Model roles not mapped');
  assert.match(a!.detail, /LiteLLM catalog: timeout after 12000ms/);
  assert.match(a!.detail, /Platform → Models → Roles/);
  assert.ok(h.lines.some((l) => l.level === 'error' && /MODEL ROLES NOT MAPPED/.test(l.line)), 'logged loudly once persistent');
  assert.equal(roleSeedAlert(snapshot, true), null, 'a mapping that exists now (an admin set it) clears it');
  assert.equal(roleSeedAlert(roleSeedStatus(), false), null, 'cleared after the loop succeeded');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The first mapping in `os/models.yml`: seeded from the chart, or migrated once from the old admin override.
 * USER STORY: As an operator upgrading to the role names I keep the models my admin had chosen, the file is
 *             written once, a second run changes nothing, and I can see what it would do first (dry run).
 * ARCHITECTURE:
 *   - `seedRoleMapping(io, input, opts)` — pure over injected IO. It acts ONLY when `os/models.yml` does not
 *     exist. Per role: the old override (reasoning → strong, standard → worker, embeddings → embedding) if it
 *     is a model in the LiteLLM catalog, else the chart seed. A role with neither is `incomplete` (nothing
 *     is invented, nothing is written). An unreadable catalog writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRoleMapping, type SeedIo } from '@core/models/role-seed';
import type { RoleMapping } from '@core/models/role-mapping';

const SEED: RoleMapping = { 'sovereign-strong': 'stackit-qwen3-vl-235b', 'sovereign-worker': 'stackit-gpt-oss-20b', 'sovereign-embedding': 'stackit-embed' };
const CATALOG = ['stackit-qwen3-vl-235b', 'stackit-gpt-oss-20b', 'stackit-embed', 'kimi-k3.1-pro', 'deepseek-v4.1-flash'];

function io(file: RoleMapping | null = null, catalog: string[] | null = CATALOG) {
  const state = { file, writes: [] as { mapping: RoleMapping; by: string }[] };
  const i: SeedIo = {
    readMapping: async () => state.file,
    writeMapping: async (mapping, by) => { state.writes.push({ mapping, by }); state.file = mapping; return { sha: `c${state.writes.length}`, changed: true }; },
    catalog: async () => (catalog ? { ok: true, data: catalog } : { ok: false, error: 'LiteLLM unreachable' }),
  };
  return { i, state };
}

test('no file, no old override: the chart seed is written', async () => {
  const { i, state } = io();
  const r = await seedRoleMapping(i, { seed: SEED, legacy: null }, { by: 'system:os-ui' });
  assert.equal(r.state, 'seeded');
  assert.deepEqual(state.file, SEED);
  assert.equal(state.writes.length, 1);
});

test('an old admin override is migrated (reasoning → strong, standard → worker, embeddings → embedding), the rest from the seed', async () => {
  const { i, state } = io();
  const r = await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'kimi-k3.1-pro', standard: 'deepseek-v4.1-flash', tools: '', embeddings: '' } }, { by: 'system:os-ui' });
  assert.equal(r.state, 'migrated');
  assert.deepEqual(state.file, { 'sovereign-strong': 'kimi-k3.1-pro', 'sovereign-worker': 'deepseek-v4.1-flash', 'sovereign-embedding': 'stackit-embed' });
  assert.equal(r.sources['sovereign-strong'], 'legacy');
  assert.equal(r.sources['sovereign-embedding'], 'seed');
});

test('IDEMPOTENT: a second run changes nothing and writes no commit', async () => {
  const { i, state } = io();
  await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'kimi-k3.1-pro' } }, { by: 'system:os-ui' });
  const before = JSON.stringify(state.file);
  const again = await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'kimi-k3.1-pro' } }, { by: 'system:os-ui' });
  assert.equal(again.state, 'already-mapped');
  assert.equal(state.writes.length, 1);
  assert.equal(JSON.stringify(state.file), before);
});

test('NEGATIVE TWIN: an existing mapping is never overwritten by the seed or an old override', async () => {
  const mine: RoleMapping = { 'sovereign-strong': 'kimi-k3.1-pro', 'sovereign-worker': 'deepseek-v4.1-flash', 'sovereign-embedding': 'stackit-embed' };
  const { i, state } = io(mine);
  const r = await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'stackit-qwen3-vl-235b' } }, { by: 'system:os-ui' });
  assert.equal(r.state, 'already-mapped');
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.file, mine);
});

test('DRY RUN reports what it would write and writes nothing', async () => {
  const { i, state } = io();
  const r = await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'kimi-k3.1-pro' } }, { by: 'admin1', dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.state, 'migrated');
  assert.equal(r.mapping!['sovereign-strong'], 'kimi-k3.1-pro');
  assert.equal(state.writes.length, 0);
  assert.equal(state.file, null);
});

test('an old override that names a model the catalog does not have is skipped (reported), the seed fills the role', async () => {
  const { i, state } = io();
  const r = await seedRoleMapping(i, { seed: SEED, legacy: { reasoning: 'sovereign-reasoning' } }, { by: 'system:os-ui' });
  assert.equal(state.file!['sovereign-strong'], SEED['sovereign-strong']);
  assert.deepEqual(r.skipped.map((s) => [s.role, s.from]), [['sovereign-strong', 'sovereign-reasoning']]);
});

test('NEGATIVE TWIN: nothing to map a role to (no override, no seed) is incomplete — nothing is invented or written', async () => {
  const { i, state } = io();
  const r = await seedRoleMapping(i, { seed: null, legacy: { reasoning: 'kimi-k3.1-pro' } }, { by: 'system:os-ui' });
  assert.equal(r.state, 'incomplete');
  assert.equal(state.writes.length, 0);
});

test('NEGATIVE TWIN: an unreadable catalog writes nothing', async () => {
  const { i, state } = io(null, null);
  const r = await seedRoleMapping(i, { seed: SEED, legacy: null }, { by: 'system:os-ui' });
  assert.equal(r.state, 'unreadable');
  assert.equal(state.writes.length, 0);
});

test('NEGATIVE TWIN: a seed that names a model outside the catalog is not written', async () => {
  const { i, state } = io(null, ['other']);
  const r = await seedRoleMapping(i, { seed: SEED, legacy: null }, { by: 'system:os-ui' });
  assert.equal(r.state, 'incomplete');
  assert.equal(state.writes.length, 0);
});

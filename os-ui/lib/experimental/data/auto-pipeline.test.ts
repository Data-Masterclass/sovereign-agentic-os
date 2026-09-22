/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoAdvancePipeline } from './auto-pipeline.ts';
import type { Dataset } from './dataset-schema.ts';
import type { Profile } from './profile.ts';

/**
 * The auto-advance orchestration (Task 2): after Bronze commits, build Silver → Gold and
 * suggest + STORE default DQ rules with NO extra button presses. The contract under test:
 *   1. it CHAINS all stages and STORES the suggested checks;
 *   2. it is BEST-EFFORT — one stage failing NEVER aborts the rest;
 *   3. it stores ONLY the deduped suggestions `suggestChecks` returns (never re-adds an
 *      existing rule).
 * Effects are injected, so this tests the decision path without a live stack.
 */

const user = { id: 'u1', domains: ['d1'], role: 'creator' as const };

/** A minimal dataset the orchestration only reads by id/checks. */
function ds(checks: Dataset['checks'] = []): Dataset {
  return { id: 'ds1', checks } as unknown as Dataset;
}

/** A tiny profile: one complete, low-cardinality-but-not-unique column ⇒ ONLY not_null. */
const profile: Profile = {
  fqn: 'x', layer: 'gold', rowCount: 100,
  columns: [{ name: 'id', kind: 'numeric', type: 'bigint', nulls: 0, distinct: 50, min: null, max: null, top: [] }],
} as unknown as Profile;

test('chains Silver → Gold and stores the suggested DQ rules', async () => {
  const built: string[] = [];
  const stored: string[] = [];
  const res = await autoAdvancePipeline('ds1', user, {
    commit: async (_d, layer) => { built.push(layer); return true; },
    reload: () => ds(),
    profile: async () => profile,
    store: (s) => { stored.push(`${s.rule}:${s.column}`); },
  });
  assert.deepEqual(built, ['silver', 'gold'], 'both layers committed, in order');
  assert.deepEqual(res, { silver: true, gold: true, checks: 1 });
  assert.deepEqual(stored, ['not_null:id'], 'the obvious rule was stored');
});

test('best-effort: a Silver failure does NOT abort Gold or the DQ store', async () => {
  const built: string[] = [];
  const stored: string[] = [];
  const res = await autoAdvancePipeline('ds1', user, {
    commit: async (_d, layer) => {
      if (layer === 'silver') throw new Error('silver blew up');
      built.push(layer);
      return true;
    },
    reload: () => ds(),
    profile: async () => profile,
    store: (s) => { stored.push(`${s.rule}:${s.column}`); },
  });
  assert.equal(res.silver, false, 'silver failed');
  assert.equal(res.gold, true, 'gold still ran');
  assert.deepEqual(built, ['gold']);
  assert.equal(res.checks, 1, 'DQ store still ran');
  assert.deepEqual(stored, ['not_null:id']);
});

test('best-effort: no queryable profile ⇒ zero checks, no throw', async () => {
  const res = await autoAdvancePipeline('ds1', user, {
    commit: async () => true,
    reload: () => ds(),
    profile: async () => null,
    store: () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(res, { silver: true, gold: true, checks: 0 });
});

test('does not re-store a rule the dataset already has (dedupe)', async () => {
  const stored: string[] = [];
  const res = await autoAdvancePipeline('ds1', user, {
    commit: async () => true,
    // The dataset already carries not_null(id) — suggestChecks must drop it.
    reload: () => ds([{ id: 'c1', name: 'nn', description: '', createdBy: 'u1', createdAt: 't', rule: 'not_null', column: 'id' }]),
    profile: async () => profile,
    store: (s) => { stored.push(`${s.rule}:${s.column}`); },
  });
  assert.equal(res.checks, 0, 'the existing rule is not re-stored');
  assert.deepEqual(stored, []);
});

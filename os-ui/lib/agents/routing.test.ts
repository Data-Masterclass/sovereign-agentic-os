/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITIES,
  defaultRoutingTable,
  resolveModel,
  tierOf,
  routeProbe,
  TIER_MODELS,
  REASONING_TARGETS,
} from './routing.ts';

test('the default table routes light work to Ministral and reasoning to the local sovereign model', () => {
  const table = defaultRoutingTable();
  assert.equal(table.coding.tier, 'light');
  assert.equal(table.coding.model, TIER_MODELS.light);
  assert.equal(table['tool-selection'].tier, 'light');
  assert.equal(table.planning.tier, 'reasoning');
  assert.equal(table.planning.model, TIER_MODELS.reasoning);
  assert.equal(table.vision.tier, 'vision');
});

test('reasoning defaults to the local sovereign Magistral model (not STACKIT)', () => {
  assert.equal(TIER_MODELS.reasoning, 'sovereign-reasoning');
});

test('routeProbe: a light prompt hits the Ministral tier', () => {
  const probe = routeProbe('coding', defaultRoutingTable());
  assert.equal(probe.tier, 'light');
  assert.match(probe.model, /ministral/i);
});

test('routeProbe: a reasoning prompt hits the local sovereign reasoning model', () => {
  const probe = routeProbe('planning', defaultRoutingTable());
  assert.equal(probe.tier, 'reasoning');
  assert.match(probe.model, /sovereign-reasoning/i);
});

test('a per-agent model override resolves over the activity routing', () => {
  const table = defaultRoutingTable();
  // unset → activity routing
  assert.equal(resolveModel('coding', table), TIER_MODELS.light);
  // set → the agent model wins
  assert.equal(resolveModel('coding', table, 'my-custom-model'), 'my-custom-model');
});

test('a workspace override replaces an activity default', () => {
  const table = defaultRoutingTable();
  table.coding = { tier: 'reasoning', model: 'stackit-qwen3-vl-reasoning' };
  assert.equal(resolveModel('coding', table), 'stackit-qwen3-vl-reasoning');
});

test('tierOf classifies known model_names', () => {
  assert.equal(tierOf('ministral-3'), 'light');
  assert.equal(tierOf('sovereign-default'), 'light');
  assert.equal(tierOf('sovereign-reasoning'), 'reasoning');        // local Magistral
  assert.equal(tierOf('sovereign-reasoning-fast'), 'reasoning');   // STACKIT fast/fallback
  assert.equal(tierOf('stackit-qwen3-vl-reasoning'), 'reasoning'); // legacy alias
  assert.equal(tierOf('stackit-qwen3-vl'), 'vision');
});

test('the reasoning targets are the two local Mistral models: local default + light', () => {
  const models = REASONING_TARGETS.map((t) => t.model);
  assert.deepEqual(models, ['sovereign-reasoning', 'sovereign-default']);
  // the local sovereign Magistral is first and is the reasoning-tier default
  assert.equal(REASONING_TARGETS[0].model, TIER_MODELS.reasoning);
  // the second target is the in-box light model (Ministral)
  assert.equal(tierOf(REASONING_TARGETS[1].model), 'light');
  // every target carries a human label + a one-line hint for the picker
  for (const t of REASONING_TARGETS) {
    assert.ok(t.label.length > 0, `${t.model} has a label`);
    assert.ok(t.hint.length > 0, `${t.model} has a hint`);
  }
});

test('every activity has a default route', () => {
  const table = defaultRoutingTable();
  for (const a of ACTIVITIES) assert.ok(table[a].model, `${a} has a model`);
});

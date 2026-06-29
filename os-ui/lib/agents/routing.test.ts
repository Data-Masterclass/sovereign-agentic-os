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
} from './routing.ts';

test('the default table routes light work to Ministral and reasoning to Qwen', () => {
  const table = defaultRoutingTable();
  assert.equal(table.coding.tier, 'light');
  assert.equal(table.coding.model, TIER_MODELS.light);
  assert.equal(table['tool-selection'].tier, 'light');
  assert.equal(table.planning.tier, 'reasoning');
  assert.equal(table.planning.model, TIER_MODELS.reasoning);
  assert.equal(table.vision.tier, 'vision');
});

test('routeProbe: a light prompt hits the Ministral tier', () => {
  const probe = routeProbe('coding', defaultRoutingTable());
  assert.equal(probe.tier, 'light');
  assert.match(probe.model, /ministral/i);
});

test('routeProbe: a reasoning prompt hits the Qwen tier', () => {
  const probe = routeProbe('planning', defaultRoutingTable());
  assert.equal(probe.tier, 'reasoning');
  assert.match(probe.model, /qwen/i);
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
  assert.equal(tierOf('stackit-qwen3-vl-reasoning'), 'reasoning');
  assert.equal(tierOf('stackit-qwen3-vl'), 'vision');
});

test('every activity has a default route', () => {
  const table = defaultRoutingTable();
  for (const a of ACTIVITIES) assert.ok(table[a].model, `${a} has a model`);
});

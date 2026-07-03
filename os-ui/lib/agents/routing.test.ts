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
  MODEL_CATALOG,
  MODEL_MODES,
  modeForModel,
  modelInfo,
  provenanceOf,
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

test('routeProbe: a light prompt hits the sovereign-default (light) model', () => {
  const probe = routeProbe('coding', defaultRoutingTable());
  assert.equal(probe.tier, 'light');
  assert.equal(probe.model, 'sovereign-default'); // the REAL live light alias
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
  assert.equal(tierOf('sovereign-reasoning'), 'reasoning');        // local Magistral
  assert.equal(tierOf('sovereign-reasoning-fast'), 'reasoning');   // STACKIT fast/fallback
  assert.equal(tierOf('stackit-qwen3-vl-reasoning'), 'reasoning'); // legacy alias
  assert.equal(tierOf('stackit-qwen3-vl'), 'vision');
});

test('MODEL_CATALOG contains ONLY real live gateway model_names (no phantoms)', () => {
  // Every catalog entry carries a human display + tier + provenance; the key IS
  // the real LiteLLM model_name from the live proxy_config.model_list.
  for (const [name, info] of Object.entries(MODEL_CATALOG)) {
    assert.equal(info.model_name, name, `${name} keyed by its own model_name`);
    assert.ok(info.display.length > 0, `${name} has a display name`);
    assert.ok(['light', 'reasoning', 'vision'].includes(info.tier), `${name} has a tier`);
    assert.ok(['internal', 'external'].includes(info.provenance), `${name} has provenance`);
    // Every catalog id must be a sovereign alias — the only family on the live
    // gateway. No `ministral-*` / `stackit-*` / other-provider phantoms.
    assert.ok(name.startsWith('sovereign-'), `${name} is a real sovereign gateway alias`);
  }
  // The two toggle targets exist and are sovereign (internal).
  assert.equal(MODEL_CATALOG['sovereign-default'].provenance, 'internal');
  assert.equal(MODEL_CATALOG['sovereign-reasoning'].provenance, 'internal');
  // No phantom ids leaked back in.
  assert.equal(MODEL_CATALOG['ministral-3'], undefined);
  assert.equal(MODEL_CATALOG['stackit-qwen3-vl'], undefined);
});

test('provenanceOf: catalog wins; unknown names fall back to prefix heuristics', () => {
  assert.equal(provenanceOf('sovereign-default'), 'internal');
  assert.equal(provenanceOf('sovereign-reasoning'), 'internal');
  assert.equal(provenanceOf('sovereign-vision'), 'internal');
  // unknown in-box-looking prefix → internal; hosted/other-provider → external
  assert.equal(provenanceOf('ministral-custom-7b'), 'internal'); // self-host prefix heuristic
  assert.equal(provenanceOf('gpt-4o'), 'external');
  assert.equal(provenanceOf('stackit-anything'), 'external');
});

test('modelInfo resolves unknown model_names via heuristics (never throws)', () => {
  const known = modelInfo('sovereign-reasoning');
  assert.equal(known.display, 'Sovereign Reasoning');
  const unknown = modelInfo('mystery-model-x');
  assert.equal(unknown.model_name, 'mystery-model-x');
  assert.equal(unknown.display, 'mystery-model-x'); // display falls back to the id
  assert.ok(['internal', 'external'].includes(unknown.provenance));
});

test('the thinking toggle is 3-state Auto/Reasoning/Execution with real model pins', () => {
  const modes = MODEL_MODES.map((m) => m.mode);
  assert.deepEqual(modes, ['auto', 'reasoning', 'execution']);
  // Auto pins nothing (workspace routing decides).
  assert.equal(MODEL_MODES.find((m) => m.mode === 'auto')!.model, null);
  // Reasoning pins the in-box Magistral; Execution pins the in-box Ministral.
  assert.equal(MODEL_MODES.find((m) => m.mode === 'reasoning')!.model, TIER_MODELS.reasoning);
  assert.equal(MODEL_MODES.find((m) => m.mode === 'execution')!.model, TIER_MODELS.light);
  for (const m of MODEL_MODES) assert.ok(m.label && m.hint, `${m.mode} has label + hint`);
});

test('modeForModel maps an agent pin back to its toggle state', () => {
  assert.equal(modeForModel(null), 'auto');          // no pin → Auto
  assert.equal(modeForModel(undefined), 'auto');
  assert.equal(modeForModel(''), 'auto');
  assert.equal(modeForModel('sovereign-default'), 'execution'); // the real light alias
  assert.equal(modeForModel('sovereign-reasoning'), 'reasoning');
  assert.equal(modeForModel('sovereign-vision'), 'reasoning'); // any non-light pin reads as Reasoning
});

test('every activity has a default route', () => {
  const table = defaultRoutingTable();
  for (const a of ACTIVITIES) assert.ok(table[a].model, `${a} has a model`);
});

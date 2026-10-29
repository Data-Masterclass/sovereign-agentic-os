/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Agents stage model (lib/agents/stages.ts) — the pure Define · Grant ·
 * Design · Build · Run · Evaluate path: its ids, gates, ✓ conditions and the legacy alias.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STAGES, aliasStageId, type AgentStageCtx } from '@tabs/agents/lib/stages';
import { canEnter, isSatisfied } from '@core/kernel/stages';

const base: AgentStageCtx = {
  named: false,
  ready: false,
  builtOk: false,
  hasRun: false,
  checksPass: false,
};

test('stages: the six ids are define · grant · design · build · run · evaluate, in order', () => {
  assert.deepEqual(
    AGENT_STAGES.map((s) => s.id),
    ['define', 'grant', 'design', 'build', 'run', 'evaluate'],
  );
  assert.deepEqual(
    AGENT_STAGES.map((s) => s.title),
    ['Define', 'Grant', 'Design', 'Build', 'Run', 'Evaluate'],
  );
});

test('stages: Define is always reachable; Grant needs a named system', () => {
  assert.equal(canEnter(AGENT_STAGES, 'define', base), true);
  assert.equal(canEnter(AGENT_STAGES, 'grant', base), false);
  assert.equal(canEnter(AGENT_STAGES, 'grant', { ...base, named: true }), true);
});

test('stages: Design is always reachable (blank-canvas + auto-suggest)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'design', base), true);
  assert.equal(canEnter(AGENT_STAGES, 'design', { ...base, named: true }), true);
});

test('stages: Build is gated on a runnable team (agents + entrypoint)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'build', { ...base, named: true, ready: false }), false);
  assert.equal(canEnter(AGENT_STAGES, 'build', { ...base, ready: true }), true);
});

test('stages: Run is gated on a green build (ready + builtOk)', () => {
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: true, builtOk: false }), false);
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: false, builtOk: true }), false);
  assert.equal(canEnter(AGENT_STAGES, 'run', { ...base, ready: true, builtOk: true }), true);
});

test('stages: Evaluate is blocked until a run exists (and a runnable team)', () => {
  // Ready but no run → not reachable.
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: true, hasRun: false }), false);
  // A run without a ready team is impossible in practice, but the gate needs both.
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: false, hasRun: true }), false);
  assert.equal(canEnter(AGENT_STAGES, 'evaluate', { ...base, ready: true, hasRun: true }), true);
});

test('stages: Define ✓ = named; Grant ✓ = named', () => {
  assert.equal(isSatisfied(AGENT_STAGES, 'define', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'define', { ...base, named: true }), true);
  assert.equal(isSatisfied(AGENT_STAGES, 'grant', { ...base, named: true }), true);
});

test('stages: Design ✓ = ready (a runnable team)', () => {
  assert.equal(isSatisfied(AGENT_STAGES, 'design', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'design', { ...base, ready: true }), true);
});

test('stages: Build ✓ = built; Run ✓ = run; Evaluate ✓ = checks pass', () => {
  assert.equal(isSatisfied(AGENT_STAGES, 'build', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'build', { ...base, builtOk: true }), true);
  assert.equal(isSatisfied(AGENT_STAGES, 'run', base), false);
  assert.equal(isSatisfied(AGENT_STAGES, 'run', { ...base, hasRun: true }), true);
  assert.equal(isSatisfied(AGENT_STAGES, 'evaluate', { ...base, checksPass: true }), true);
  assert.equal(isSatisfied(AGENT_STAGES, 'evaluate', base), false);
});

test('aliasStageId: the legacy merged `build-run` id folds onto `build`', () => {
  assert.equal(aliasStageId('build-run'), 'build');
});

test('aliasStageId: current ids pass through; an unknown id falls back to define', () => {
  for (const id of ['define', 'grant', 'design', 'build', 'run', 'evaluate']) {
    assert.equal(aliasStageId(id), id);
  }
  assert.equal(aliasStageId('nope'), 'define');
  assert.equal(aliasStageId(''), 'define');
});

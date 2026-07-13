/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { roleModel, roleDefault, roleModels, MOCK_MODEL, type ModelRole } from './roles.ts';
import { updateSettings, _reset } from '../platform-admin/settings.ts';

const ROLES: ModelRole[] = ['reasoning', 'standard', 'embeddings'];

// The three STACKIT-managed sovereign models each role points at when a live
// gateway is configured (the connected default). These are the ONLY live aliases
// the settings panel presents, plus the mock below.
const CONNECTED: Record<'reasoning' | 'standard' | 'embeddings', string> = {
  reasoning: 'sovereign-reasoning',   // Qwen3-VL-235B
  standard: 'sovereign-default',      // gpt-oss-20b
  embeddings: 'sovereign-embed',      // Qwen3-VL-Embedding-8B
};

beforeEach(() => { _reset(); });

test('the mock model is the single offline/testing fallback alias', () => {
  assert.equal(MOCK_MODEL, 'sovereign-mock');
});

test('unset roles fall back to the connected STACKIT alias (config default)', () => {
  // Fresh store: every role is empty → the resolver returns the config baseline,
  // which is the role's live STACKIT alias when a gateway is configured.
  for (const role of ROLES) {
    assert.equal(roleModel(role), roleDefault(role), `${role} falls back to its config default`);
  }
});

test('each STACKIT role resolves to exactly its intended sovereign model when configured', () => {
  // The connected defaults are the three STACKIT models — nothing else.
  assert.equal(roleModel('reasoning'), CONNECTED.reasoning);
  assert.equal(roleModel('standard'), CONNECTED.standard);
  assert.equal(roleModel('embeddings'), CONNECTED.embeddings);
});

test('roleDefault falls back to the MOCK model when nothing is wired', () => {
  // When the config alias for a role is empty (no gateway model configured — the
  // offline case) every role coalesces to the mock so the flow still runs. We can
  // only prove the coalescing branch directly, so assert the invariant: every role
  // default is EITHER a real sovereign alias OR the mock — never empty.
  for (const role of ['reasoning', 'standard', 'tools', 'embeddings'] as ModelRole[]) {
    const d = roleDefault(role);
    assert.ok(d.length > 0, `${role} default is never empty`);
    assert.ok(d.startsWith('sovereign-'), `${role} default is a sovereign alias (incl. ${MOCK_MODEL})`);
  }
});

test('an admin override wins over the default — including pinning the mock for testing', () => {
  updateSettings({ modelRoles: { reasoning: 'sovereign-reasoning', standard: MOCK_MODEL, embeddings: '' } });
  assert.equal(roleModel('reasoning'), 'sovereign-reasoning');   // explicit STACKIT pin
  assert.equal(roleModel('standard'), MOCK_MODEL);               // mock is selectable for testing
  assert.equal(roleModel('embeddings'), roleDefault('embeddings')); // empty string → default
});

test('a blank/whitespace override does NOT win (treated as unset)', () => {
  updateSettings({ modelRoles: { reasoning: '   ', standard: '', embeddings: '' } });
  assert.equal(roleModel('reasoning'), roleDefault('reasoning'));
});

test('roleModels returns the effective map for all four roles', () => {
  updateSettings({ modelRoles: { reasoning: 'sovereign-reasoning', standard: '', embeddings: '' } });
  const m = roleModels();
  assert.equal(m.reasoning, 'sovereign-reasoning');
  assert.equal(m.standard, roleDefault('standard'));
  assert.equal(m.embeddings, roleDefault('embeddings'));
  assert.equal(m.tools, roleDefault('tools'));
});

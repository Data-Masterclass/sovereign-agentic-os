/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { roleModel, roleDefault, roleModels, type ModelRole } from './roles.ts';
import { updateSettings, _reset } from '../platform-admin/settings.ts';

const ROLES: ModelRole[] = ['reasoning', 'standard', 'embeddings'];

beforeEach(() => { _reset(); });

test('unset roles fall back to the config env default', () => {
  // Fresh store: every role is empty → the resolver returns the config baseline.
  for (const role of ROLES) {
    assert.equal(roleModel(role), roleDefault(role), `${role} falls back to its env default`);
  }
});

test('an admin override wins over the env default', () => {
  updateSettings({ modelRoles: { reasoning: 'sovereign-premium', standard: 'sovereign-reasoning-fast', embeddings: '' } });
  assert.equal(roleModel('reasoning'), 'sovereign-premium');   // override wins
  assert.equal(roleModel('standard'), 'sovereign-reasoning-fast');
  assert.equal(roleModel('embeddings'), roleDefault('embeddings')); // empty string → default
});

test('a blank/whitespace override does NOT win (treated as unset)', () => {
  updateSettings({ modelRoles: { reasoning: '   ', standard: '', embeddings: '' } });
  assert.equal(roleModel('reasoning'), roleDefault('reasoning'));
});

test('roleModels returns the effective map for all three roles', () => {
  updateSettings({ modelRoles: { reasoning: 'sovereign-premium', standard: '', embeddings: '' } });
  const m = roleModels();
  assert.equal(m.reasoning, 'sovereign-premium');
  assert.equal(m.standard, roleDefault('standard'));
  assert.equal(m.embeddings, roleDefault('embeddings'));
});

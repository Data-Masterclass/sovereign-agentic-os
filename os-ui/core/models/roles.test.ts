/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * `roleModel` and friends: the OS's own roles onto the three role names. The deeper behaviour
 * (old override and env ignored, every role a role name) is in `role-switch.test.ts`; this file
 * keeps the helpers that used to live next to the old override.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { roleModel, roleModels, standardFirstEscalationEnabled } from '@core/models/roles';
import { updateSettings, _reset } from '@tabs/admin/lib/settings';

beforeEach(() => { _reset(); });

test('tools follows the worker role, coder follows the strong role (no env or setting decides)', () => {
  assert.equal(roleModel('tools'), roleModel('standard'));
  assert.equal(roleModel('coder'), roleModel('reasoning'));
});

test('roleModels returns the role name for each of the five OS roles', () => {
  assert.deepEqual(roleModels(), {
    standard: 'sovereign-worker', tools: 'sovereign-worker', reasoning: 'sovereign-strong', coder: 'sovereign-strong', embeddings: 'sovereign-embedding',
  });
});

test('standard-first escalation is a switch, on by default, and does not change which names are called', () => {
  assert.equal(standardFirstEscalationEnabled(), true);
  updateSettings({ standardFirstEscalation: false });
  assert.equal(standardFirstEscalationEnabled(), false);
  assert.equal(roleModel('standard'), 'sovereign-worker');
});

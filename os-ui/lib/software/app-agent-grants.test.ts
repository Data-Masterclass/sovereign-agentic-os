/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyAgentGrants,
  normalizeAgentGrants,
  isAgentGranted,
  agentAccessOf,
  setAgentGrant,
} from './app-agent-grants.ts';

test('emptyAgentGrants is a fresh empty list', () => {
  assert.deepEqual(emptyAgentGrants(), []);
  // fresh each call (no shared mutable reference)
  assert.notEqual(emptyAgentGrants(), emptyAgentGrants());
});

test('normalizeAgentGrants: legacy undefined / non-array → []', () => {
  assert.deepEqual(normalizeAgentGrants(undefined), []);
  assert.deepEqual(normalizeAgentGrants(null), []);
  assert.deepEqual(normalizeAgentGrants('sys_1'), []);
  assert.deepEqual(normalizeAgentGrants({ id: 'sys_1' }), []);
});

test('normalizeAgentGrants: drops malformed rows, keeps valid ones', () => {
  const out = normalizeAgentGrants([
    { id: 'sys_1', access: 'read-only' },
    { id: 42, access: 'read-only' }, // bad id
    { id: 'sys_2', access: 'nope' }, // bad access
    { id: 'sys_3', access: 'read-write' },
    null,
  ]);
  assert.deepEqual(out, [
    { id: 'sys_1', access: 'read-only' },
    { id: 'sys_3', access: 'read-write' },
  ]);
});

test('setAgentGrant adds, updates, and removes (pure)', () => {
  const g0 = emptyAgentGrants();
  const g1 = setAgentGrant(g0, 'sys_1', 'read-only');
  assert.deepEqual(g0, [], 'input not mutated');
  assert.deepEqual(g1, [{ id: 'sys_1', access: 'read-only' }]);
  assert.equal(isAgentGranted(g1, 'sys_1'), true);
  assert.equal(isAgentGranted(g1, 'sys_x'), false);

  // update access
  const g2 = setAgentGrant(g1, 'sys_1', 'read-propose');
  assert.equal(g2.length, 1);
  assert.equal(agentAccessOf(g2, 'sys_1'), 'read-propose');

  // add a second
  const g3 = setAgentGrant(g2, 'sys_2', 'read-only');
  assert.equal(g3.length, 2);

  // remove
  const g4 = setAgentGrant(g3, 'sys_1', null);
  assert.deepEqual(g4, [{ id: 'sys_2', access: 'read-only' }]);
});

test('agentAccessOf defaults to read-only for an ungranted id', () => {
  assert.equal(agentAccessOf(emptyAgentGrants(), 'sys_x'), 'read-only');
});

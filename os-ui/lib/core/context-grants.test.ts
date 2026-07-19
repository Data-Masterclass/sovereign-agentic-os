/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessOf,
  allowedContextAccess,
  clampAllGrants,
  clampContextAccess,
  contextAccessCap,
  emptyContextGrants,
  grantCount,
  isGranted,
  normalizeContextGrants,
  setGrant,
  type ContextGrants,
} from './context-grants.ts';

test('contextAccessCap: read-only locks every grant at read', () => {
  const cap = contextAccessCap('read-only');
  assert.equal(cap.ceiling, 'read-only');
  assert.equal(cap.locked, true);
  assert.deepEqual(allowedContextAccess(cap), ['read-only']);
});

test('contextAccessCap: full-in-scope locks every grant at read+write', () => {
  const cap = contextAccessCap('full-in-scope');
  assert.equal(cap.ceiling, 'read-write');
  assert.equal(cap.locked, true);
  assert.deepEqual(allowedContextAccess(cap), ['read-only', 'read-propose', 'read-write']);
});

test('contextAccessCap: read-propose is the middle, downgrade-only ceiling', () => {
  const cap = contextAccessCap('read-propose');
  assert.equal(cap.ceiling, 'read-propose');
  assert.equal(cap.locked, false);
  assert.deepEqual(allowedContextAccess(cap), ['read-only', 'read-propose']);
});

test('clampContextAccess: never widens above the ceiling', () => {
  const cap = contextAccessCap('read-propose');
  // A desired read+write clamps DOWN to the propose ceiling.
  assert.equal(clampContextAccess('read-write', cap), 'read-propose');
  // At or below the ceiling passes through untouched.
  assert.equal(clampContextAccess('read-only', cap), 'read-only');
  assert.equal(clampContextAccess('read-propose', cap), 'read-propose');
});

test('clampContextAccess: a locked cap forces the ceiling regardless of desire', () => {
  const cap = contextAccessCap('read-only');
  assert.equal(clampContextAccess('read-write', cap), 'read-only');
  assert.equal(clampContextAccess('read-propose', cap), 'read-only');
});

test('setGrant: adds, clamps, updates and removes a grant purely', () => {
  const cap = contextAccessCap('read-write');
  let g = emptyContextGrants();
  const before = g;
  g = setGrant(g, 'connections', 'sfdc', 'read-write', cap);
  assert.notEqual(g, before, 'returns a new object (no mutation)');
  assert.equal(before.connections.length, 0, 'input untouched');
  assert.equal(accessOf(g, 'connections', 'sfdc'), 'read-write');
  assert.equal(isGranted(g, 'connections', 'sfdc'), true);

  // Update the same id → no duplicate.
  g = setGrant(g, 'connections', 'sfdc', 'read-only', cap);
  assert.equal(g.connections.length, 1);
  assert.equal(accessOf(g, 'connections', 'sfdc'), 'read-only');

  // Remove → gone.
  g = setGrant(g, 'connections', 'sfdc', null, cap);
  assert.equal(isGranted(g, 'connections', 'sfdc'), false);
});

test('setGrant: clamps a too-high access to the cap on write', () => {
  const cap = contextAccessCap('read-propose');
  const g = setGrant(emptyContextGrants(), 'data', 'ds1', 'read-write', cap);
  assert.equal(accessOf(g, 'data', 'ds1'), 'read-propose', 'clamped down to the ceiling');
});

test('clampAllGrants: tightens every stale grant when the preset drops', () => {
  const wide = contextAccessCap('read-write');
  let g = emptyContextGrants();
  g = setGrant(g, 'connections', 'a', 'read-write', wide);
  g = setGrant(g, 'data', 'b', 'read-propose', wide);
  // Preset tightens to read-only → both grants become read.
  const clamped = clampAllGrants(g, contextAccessCap('read-only'));
  assert.equal(accessOf(clamped, 'connections', 'a'), 'read-only');
  assert.equal(accessOf(clamped, 'data', 'b'), 'read-only');
});

test('normalizeContextGrants: legacy/undefined loads as an empty full object', () => {
  const fromUndef = normalizeContextGrants(undefined);
  assert.deepEqual(fromUndef, emptyContextGrants());
  // Drops unknown kinds + malformed entries, keeps valid ones.
  const messy = normalizeContextGrants({
    connections: [{ id: 'ok', access: 'read-only' }, { id: 'bad', access: 'nope' }, { nope: 1 }],
    bogusKind: [{ id: 'x', access: 'read-only' }],
  });
  assert.deepEqual(messy.connections, [{ id: 'ok', access: 'read-only' }]);
  assert.equal(grantCount(messy), 1);
});

test('grantCount: sums across every kind', () => {
  const cap = contextAccessCap('read-write');
  let g: ContextGrants = emptyContextGrants();
  g = setGrant(g, 'connections', 'a', 'read-only', cap);
  g = setGrant(g, 'data', 'b', 'read-only', cap);
  g = setGrant(g, 'metrics', 'c', 'read-only', cap);
  assert.equal(grantCount(g), 3);
});

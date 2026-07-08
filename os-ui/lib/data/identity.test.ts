/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimsFromUser,
  delegate,
  assertDelegated,
  propagate,
  trinoGroups,
  assertOwnSandbox,
  isServiceAccount,
  IdentityError,
  type Claims,
} from './identity.ts';
import { privatePrefix } from './personal-lane.ts';

const claims: Claims = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'builder', attributes: { region: 'DE' } });

test('R2: delegation binds to the user and refuses a service account', () => {
  const tok = delegate(claims, 'domain');
  assert.equal(tok.sub, 'amir');
  assert.equal(tok.onBehalfOf, 'amir'); // acts AS the user, not a service identity
  assert.equal(isServiceAccount('svc-trino'), true);
  assert.throws(() => delegate(claimsFromUser({ id: 'svc-reader', domains: [], role: 'admin' }), 'domain'), IdentityError);
});

test('R2: a tampered token (service identity / mismatched onBehalfOf) is rejected at call time', () => {
  const tok = delegate(claims, 'domain');
  assert.doesNotThrow(() => assertDelegated(tok));
  assert.throws(() => assertDelegated({ ...tok, onBehalfOf: 'svc-super' }), IdentityError);
});

test('scope narrows the token: personal carries no domains, marketplace carries imports only', () => {
  assert.deepEqual(delegate(claims, 'personal').domains, []);
  assert.deepEqual(delegate(claims, 'domain').domains, ['sales']);
  const mk = delegate(claims, 'marketplace', { imported: ['iceberg.sales.orders_fact'] });
  assert.deepEqual(mk.domains, []);
  assert.deepEqual(mk.imported, ['iceberg.sales.orders_fact']);
});

test('R1: low-cardinality attributes + domain + role become Trino groups', () => {
  assert.deepEqual(trinoGroups(claims), ['domain:sales', 'region:DE', 'role:builder']);
});

test('R3: one identity propagates to Trino (user+groups) and Cube (securityContext)', () => {
  const ids = propagate(delegate(claims, 'domain'));
  assert.equal(ids.trino.user, 'amir');
  assert.ok(ids.trino.groups.includes('domain:sales'));
  assert.equal(ids.cube.securityContext.sub, 'amir');
  assert.equal(ids.cube.securityContext.region, 'DE'); // full claims, richer than Trino
});

test('personal lane: sandbox prefix is exposed only for personal scope, and only the user’s own', () => {
  assert.equal(propagate(delegate(claims, 'domain')).sandboxPrefix, null);
  assert.equal(propagate(delegate(claims, 'personal')).sandboxPrefix, privatePrefix('amir'));
  const tok = delegate(claims, 'personal');
  assert.doesNotThrow(() => assertOwnSandbox(tok, privatePrefix('amir')));
  assert.throws(() => assertOwnSandbox(tok, privatePrefix('bea')), IdentityError); // never another user's private lane
});

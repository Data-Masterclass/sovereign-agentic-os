/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageArtifact } from './edit-scope.ts';
import type { Role } from '../core/session.ts';

const art = { owner: 'sara', domain: 'sales' };
const user = (id: string, role: Role, domains: string[]) => ({ id, role, domains });

test('OWNER may manage — even as a bare Creator', () => {
  assert.equal(canManageArtifact(user('sara', 'creator', ['sales']), art), true);
});

test('domain_admin of the OWNING domain may manage a non-owned artifact', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['sales']), art), true);
});

test('domain_admin of ANOTHER domain is DENIED', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['ops']), art), false);
});

test('platform admin may manage anything', () => {
  assert.equal(canManageArtifact(user('alex', 'admin', ['ops']), art), true);
});

test('non-owner Builder is DENIED (the fail-closed gap this rule fixes)', () => {
  assert.equal(canManageArtifact(user('bob', 'builder', ['sales']), art), false);
});

test('non-owner Creator is DENIED', () => {
  assert.equal(canManageArtifact(user('cal', 'creator', ['sales']), art), false);
});

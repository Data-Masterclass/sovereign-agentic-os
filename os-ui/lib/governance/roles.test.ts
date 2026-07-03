/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roleRank,
  roleLabel,
  rightsToTools,
  principalFor,
  canSee,
  canApprove,
  canManageRole,
  type Actor,
} from './roles.ts';

const user: Actor = { id: 'amir', domains: ['sales'], role: 'creator' };
const builder: Actor = { id: 'bea', domains: ['sales'], role: 'builder' };
const finBuilder: Actor = { id: 'kenji', domains: ['finance'], role: 'builder' };
const admin: Actor = { id: 'sara', domains: ['sales', 'finance', 'platform'], role: 'admin' };

test('roles rank lowest→highest and label to Creator/Builder/Admin', () => {
  assert.ok(roleRank('creator') < roleRank('builder'));
  assert.ok(roleRank('builder') < roleRank('admin'));
  assert.equal(roleLabel('creator'), 'Creator');
  assert.equal(roleLabel('builder'), 'Builder');
  assert.equal(roleLabel('admin'), 'Admin');
  // An unknown/malformed role normalises to the base role's rank (0).
  assert.equal(roleRank('bogus' as unknown as Actor['role']), roleRank('creator'));
});

test('a role compiles to OPA tools (the role→OPA mapping)', () => {
  assert.equal(principalFor({ id: 'amir' }), 'user:amir');
  // Admin unlocks override + user admin; a plain User does not.
  assert.ok(rightsToTools('admin').includes('policy_override'));
  assert.ok(rightsToTools('admin').includes('user_admin'));
  assert.ok(!rightsToTools('creator').includes('policy_override'));
  // Builder can approve + deploy but not override policy.
  assert.ok(rightsToTools('builder').includes('approve'));
  assert.ok(rightsToTools('builder').includes('deploy'));
  assert.ok(!rightsToTools('builder').includes('policy_override'));
});

test('SCOPE: a domain deploy item — Builder of that domain approves, a non-Builder cannot', () => {
  const deploy = { domain: 'sales', approverRole: 'builder' as const, scope: 'domain' as const };
  assert.equal(canApprove(builder, deploy), true); // Builder of sales
  assert.equal(canApprove(admin, deploy), true); // Admin spans tenant
  assert.equal(canApprove(user, deploy), false); // a User cannot
  assert.equal(canApprove(finBuilder, deploy), false); // Builder of another domain cannot
});

test('SCOPE: a tenant egress item is Admin-only (Builder→Admin)', () => {
  const egress = { domain: 'sales', approverRole: 'admin' as const, scope: 'tenant' as const };
  assert.equal(canApprove(admin, egress), true);
  assert.equal(canApprove(builder, egress), false); // even a Builder of the domain cannot
});

test('VISIBILITY: Admin sees all, Builder sees own domain, User sees only own requests', () => {
  const salesItem = { domain: 'sales', requestedBy: 'someone' };
  const finItem = { domain: 'finance', requestedBy: 'someone' };
  assert.equal(canSee(admin, finItem), true);
  assert.equal(canSee(builder, salesItem), true);
  assert.equal(canSee(builder, finItem), false);
  assert.equal(canSee(user, salesItem), false); // not their request
  assert.equal(canSee(user, { domain: 'sales', requestedBy: 'amir' }), true); // their own
});

test('canManageRole: Admin assigns any role tenant-wide; Builder up to Builder in own domain only', () => {
  assert.equal(canManageRole(admin, 'admin', 'finance'), true);
  assert.equal(canManageRole(builder, 'builder', 'sales'), true);
  assert.equal(canManageRole(builder, 'creator', 'sales'), true);
  assert.equal(canManageRole(builder, 'admin', 'sales'), false); // never mints an Admin
  assert.equal(canManageRole(builder, 'builder', 'finance'), false); // not their domain
  assert.equal(canManageRole(user, 'creator', 'sales'), false); // Users cannot manage
});

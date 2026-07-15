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
  canAdministerUsers,
  userAdminInScope,
  canTouchUser,
  type Actor,
} from './roles.ts';

const user: Actor = { id: 'amir', domains: ['sales'], role: 'creator' };
const builder: Actor = { id: 'bea', domains: ['sales'], role: 'builder' };
const finBuilder: Actor = { id: 'kenji', domains: ['finance'], role: 'builder' };
const domainAdmin: Actor = { id: 'dana', domains: ['sales'], role: 'domain_admin' };
const admin: Actor = { id: 'sara', domains: ['sales', 'finance', 'platform'], role: 'admin' };

test('roles rank lowest→highest (4 ranks) and label to Creator/Builder/Domain admin/Admin', () => {
  assert.ok(roleRank('creator') < roleRank('builder'));
  assert.ok(roleRank('builder') < roleRank('domain_admin'));
  assert.ok(roleRank('domain_admin') < roleRank('admin'));
  assert.equal(roleLabel('creator'), 'Creator');
  assert.equal(roleLabel('builder'), 'Builder');
  assert.equal(roleLabel('domain_admin'), 'Domain admin');
  assert.equal(roleLabel('admin'), 'Admin');
  // An unknown/malformed role normalises to the base role's rank (0).
  assert.equal(roleRank('bogus' as unknown as Actor['role']), roleRank('creator'));
  assert.equal(roleRank('agentic-leader' as unknown as Actor['role']), roleRank('creator'));
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

test('domain_admin inherits EVERY builder capability (tools superset) + domain user-admin, never platform powers', () => {
  const builderTools = rightsToTools('builder');
  const daTools = rightsToTools('domain_admin');
  for (const t of builderTools) {
    assert.ok(daTools.includes(t), `domain_admin must inherit builder tool: ${t}`);
  }
  // The people-admin grants, scoped to the domain by the route tier.
  assert.ok(daTools.includes('user_admin'), 'domain_admin administers users (own domain)');
  assert.ok(daTools.includes('membership_admin'), 'domain_admin manages domain memberships');
  // Never the tenant/platform powers.
  assert.ok(!daTools.includes('policy_override'), 'no policy override');
  assert.ok(!daTools.includes('cost_cap'), 'no tenant cost caps');
  // Builder is an approver, NOT a people-admin.
  assert.ok(!builderTools.includes('user_admin'));
  assert.ok(!builderTools.includes('membership_admin'));
});

test('SCOPE: a domain deploy item — Builder of that domain approves, a non-Builder cannot', () => {
  const deploy = { domain: 'sales', approverRole: 'builder' as const, scope: 'domain' as const };
  assert.equal(canApprove(builder, deploy), true); // Builder of sales
  assert.equal(canApprove(domainAdmin, deploy), true); // Domain admin of sales (rank ≥ builder)
  assert.equal(canApprove(admin, deploy), true); // Admin spans tenant
  assert.equal(canApprove(user, deploy), false); // a User cannot
  assert.equal(canApprove(finBuilder, deploy), false); // Builder of another domain cannot
  assert.equal(
    canApprove({ ...domainAdmin, domains: ['finance'] }, deploy),
    false,
    'a Domain admin of another domain cannot approve',
  );
});

test('SCOPE: a tenant egress/certification item is (platform) Admin-only', () => {
  const egress = { domain: 'sales', approverRole: 'admin' as const, scope: 'tenant' as const };
  assert.equal(canApprove(admin, egress), true);
  assert.equal(canApprove(builder, egress), false); // even a Builder of the domain cannot
  assert.equal(canApprove(domainAdmin, egress), false); // a Domain admin cannot either
});

test('VISIBILITY: Admin sees all, Builder sees own domain, User sees only own requests', () => {
  const salesItem = { domain: 'sales', requestedBy: 'someone' };
  const finItem = { domain: 'finance', requestedBy: 'someone' };
  assert.equal(canSee(admin, finItem), true);
  assert.equal(canSee(builder, salesItem), true);
  assert.equal(canSee(builder, finItem), false);
  assert.equal(canSee(domainAdmin, salesItem), true); // Builder+ floor: own domain
  assert.equal(canSee(domainAdmin, finItem), false);
  assert.equal(canSee(user, salesItem), false); // not their request
  assert.equal(canSee(user, { domain: 'sales', requestedBy: 'amir' }), true); // their own
});

test('canManageRole: Admin any role tenant-wide; Domain admin up to Builder in own domain; Builder is NOT a people-admin', () => {
  assert.equal(canManageRole(admin, 'admin', 'finance'), true);
  assert.equal(canManageRole(admin, 'domain_admin', 'sales'), true, 'ONLY the Admin appoints domain admins');
  // Domain admin: own domain, up to builder.
  assert.equal(canManageRole(domainAdmin, 'creator', 'sales'), true);
  assert.equal(canManageRole(domainAdmin, 'builder', 'sales'), true);
  // THE invariant: a domain admin can NEVER mint another domain_admin or an admin.
  assert.equal(canManageRole(domainAdmin, 'domain_admin', 'sales'), false);
  assert.equal(canManageRole(domainAdmin, 'admin', 'sales'), false);
  assert.equal(canManageRole(domainAdmin, 'creator', 'finance'), false); // not their domain
  // Builders and creators have NO people-admin.
  assert.equal(canManageRole(builder, 'creator', 'sales'), false);
  assert.equal(canManageRole(builder, 'builder', 'sales'), false);
  assert.equal(canManageRole(user, 'creator', 'sales'), false);
});

// ---- The domain user-administration scoping matrix (pure predicates; the user-admin
// surface is Admin → Users & Access, /api/platform-admin/access) ----

test('USER-ADMIN floor: Domain admin and Admin may administer users; Builder/Creator may not', () => {
  assert.equal(canAdministerUsers('admin'), true);
  assert.equal(canAdministerUsers('domain_admin'), true);
  assert.equal(canAdministerUsers('builder'), false);
  assert.equal(canAdministerUsers('creator'), false);
});

test('USER-ADMIN subset rule: every target domain must be the actor’s own; Admin unrestricted', () => {
  assert.equal(userAdminInScope(domainAdmin, ['sales']), true); // in own domain ✓
  assert.equal(userAdminInScope(domainAdmin, ['finance']), false); // foreign domain ✗
  assert.equal(userAdminInScope(domainAdmin, ['sales', 'finance']), false, 'partially-foreign users are OUT of scope');
  assert.equal(userAdminInScope(admin, ['finance', 'ops']), true); // platform Admin unrestricted
});

test('USER-ADMIN no-lateral/no-upward: a Domain admin never touches an admin or another domain_admin', () => {
  assert.equal(canTouchUser(domainAdmin, 'creator'), true);
  assert.equal(canTouchUser(domainAdmin, 'builder'), true);
  assert.equal(canTouchUser(domainAdmin, 'domain_admin'), false, 'no lateral moves');
  assert.equal(canTouchUser(domainAdmin, 'admin'), false, 'no upward moves');
  assert.equal(canTouchUser(admin, 'domain_admin'), true);
  assert.equal(canTouchUser(admin, 'admin'), true);
});

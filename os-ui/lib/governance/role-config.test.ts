/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MATRIX,
  matrixToRights,
  resolveRoleRights,
  setCapability,
  getMatrixSync,
  isValidMatrix,
  isApplicable,
  __resetRoleConfig,
} from './role-config.ts';
import { rightsToTools, ROLE_RIGHTS } from './roles.ts';

afterEach(() => __resetRoleConfig());

// The invariant that guarantees NO existing lockdown is weakened: the seeded
// (default) matrix compiles to EXACTLY today's OPA tool-set for every role.
test('seed reproduces the current model — same OPA tools, creator stays locked down', () => {
  // Default rights compile to identical tools per role (roles.test.ts baselines).
  assert.deepEqual(rightsToTools('creator'), ['knowledge_write', 'metrics', 'query']);
  assert.deepEqual(rightsToTools('builder'), ['approve', 'deploy', 'knowledge_write', 'membership_admin', 'metrics', 'query']);
  assert.deepEqual(rightsToTools('admin'), ['approve', 'cost_cap', 'deploy', 'egress', 'knowledge_write', 'metrics', 'policy_override', 'query', 'user_admin']);

  // creator + builder compile back to their exact hardcoded ROLE_RIGHTS.
  assert.deepEqual(matrixToRights(DEFAULT_MATRIX, 'creator'), [...ROLE_RIGHTS.creator].sort());
  assert.deepEqual(matrixToRights(DEFAULT_MATRIX, 'builder'), [...ROLE_RIGHTS.builder].sort());

  // The creator lockdown: no promote / approve / admin rights by default.
  const creatorRights = matrixToRights(DEFAULT_MATRIX, 'creator');
  for (const forbidden of ['promote.shared', 'approve.domain', 'approve.tenant', 'manage.users.tenant', 'override.policy', 'promote.certify']) {
    assert.ok(!creatorRights.includes(forbidden), `creator must not seed with ${forbidden}`);
  }
  assert.ok(!rightsToTools('creator').includes('policy_override'));
  assert.ok(!rightsToTools('creator').includes('user_admin'));
});

test('an admin edit changes the effective right + the compiled OPA tools', async () => {
  // Grant the creator role "approve" on governance → it gains approve.domain,
  // which compiles to the `approve` OPA tool. Proof an edit propagates.
  assert.ok(!rightsToTools('creator').includes('approve'));
  await setCapability('creator', 'governance', 'approve', true);
  assert.ok(resolveRoleRights('creator').includes('approve.domain'));
  assert.ok(rightsToTools('creator').includes('approve'), 'the OPA tool set must reflect the edit');

  // And removing it reverts.
  await setCapability('creator', 'governance', 'approve', false);
  assert.ok(!rightsToTools('creator').includes('approve'));
});

test('deny-by-default: a malformed / empty config falls back to the safe defaults', () => {
  // With nothing hydrated, the sync resolver returns the safe default matrix.
  assert.deepEqual(getMatrixSync(), DEFAULT_MATRIX);
  assert.deepEqual(resolveRoleRights('builder'), [...ROLE_RIGHTS.builder].sort());

  // Malformed shapes are rejected by the validator (→ the loader keeps defaults).
  assert.equal(isValidMatrix(null), false);
  assert.equal(isValidMatrix({}), false);
  assert.equal(isValidMatrix('nope'), false);
  // A structurally-fine matrix that strips the admin platform-manage power is
  // INVALID (would lock every admin out) → deny-by-default.
  const locked = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  locked.admin.platform = locked.admin.platform.filter((c: string) => c !== 'manage');
  assert.equal(isValidMatrix(locked), false);
  assert.equal(isValidMatrix(DEFAULT_MATRIX), true);
});

test('you cannot remove the last admin’s admin rights (platform management)', async () => {
  await assert.rejects(
    () => setCapability('admin', 'platform', 'manage', false),
    (err: { status?: number }) => err.status === 400,
  );
  // Admin keeps the tenant-admin grant no matter what.
  assert.ok(rightsToTools('admin').includes('user_admin'));
});

test('non-applicable cells are rejected + not toggleable', async () => {
  // "manage" is meaningless on a work component (no right) — the UI hides it and
  // the store refuses it.
  assert.equal(isApplicable('data', 'manage'), false);
  assert.equal(isApplicable('platform', 'manage'), true);
  await assert.rejects(
    () => setCapability('builder', 'data', 'manage', true),
    (err: { status?: number }) => err.status === 400,
  );
});

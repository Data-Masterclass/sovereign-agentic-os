/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Forgejo user provisioning (#146 Phase 2): username derivation is deterministic +
 * charset-safe, and `ensureForgejoUser` is IDEMPOTENT against a fake admin client —
 * a second call for the same uid does not create a second user.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoAdminClient } from './forgejo-admin.ts';
import { forgejoUsername, forgejoEmail, ensureForgejoUser } from './forgejo-users.ts';

// A minimal in-memory fake admin client: records created users; "already exists" is
// a clean no-op (as the real client treats 409/422).
function fakeAdmin() {
  const users = new Set<string>();
  const client: ForgejoAdminClient = {
    async ensureUser(username) {
      users.add(username); // Set = idempotent by construction, mirroring the real no-op
    },
    async createToken() {
      throw new Error('not used in this test');
    },
    async deleteTokensByPrefix() {
      return { deleted: 0 };
    },
  };
  return { client, users };
}

let admin: ReturnType<typeof fakeAdmin>;
beforeEach(() => { admin = fakeAdmin(); });

test('forgejoUsername is deterministic, prefixed, and charset-safe', () => {
  assert.equal(forgejoUsername('alex'), 'os-alex');
  assert.equal(forgejoUsername('Alex@DataMasterclass.com'), 'os-alex-datamasterclass.com');
  // disallowed chars → '-', repeated '-' collapse, leading/trailing separators trimmed
  assert.equal(forgejoUsername('  weird  id!! '), 'os-weird-id');
  // exotic uid never yields an empty or bad name
  assert.equal(forgejoUsername('***'), 'os-user');
  // stable: same uid → same username
  assert.equal(forgejoUsername('u1'), forgejoUsername('u1'));
});

test('forgejoEmail derives a stable non-routable synthetic address', () => {
  assert.equal(forgejoEmail('os-alex'), 'os-alex@os-git.invalid');
});

test('ensureForgejoUser creates the mirrored user and returns its username', async () => {
  const username = await ensureForgejoUser(admin.client, 'alex');
  assert.equal(username, 'os-alex');
  assert.ok(admin.users.has('os-alex'));
});

test('ensureForgejoUser is idempotent — a second call adds no second user', async () => {
  await ensureForgejoUser(admin.client, 'alex');
  await ensureForgejoUser(admin.client, 'alex');
  assert.equal(admin.users.size, 1);
});

test('ensureForgejoUser propagates a real provisioning failure (never silent)', async () => {
  const failing: ForgejoAdminClient = {
    async ensureUser() { throw new Error('Forgejo ensureUser(os-alex) failed (503)'); },
    async createToken() { throw new Error('n/a'); },
    async deleteTokensByPrefix() { return { deleted: 0 }; },
  };
  await assert.rejects(ensureForgejoUser(failing, 'alex'), /failed \(503\)/);
});

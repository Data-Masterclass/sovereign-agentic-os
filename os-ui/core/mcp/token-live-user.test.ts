/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An MCP token resolves the user as they are now
 * USER STORY: As an admin who deactivates a user or archives a domain, I want that person's MCP
 *             client (Claude, ChatGPT, …) to lose access the same moment their browser session
 *             does: a deactivated account's token stops working, and an archived domain leaves
 *             the token's scope.
 * ARCHITECTURE:
 *   - Drives the REAL `resolveMcpUser` (the only authentication path the MCP route uses) with a
 *     REAL signed token. The user directory and the domain registry are module mocks, so the
 *     test flips "deactivated" and "archived" without a cluster, and imports no tab.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type U = { id: string; name: string; domains: string[]; role: string; disabled?: boolean; mustChangeCredentials?: boolean };
let USERS: Record<string, U> = {};
const ARCHIVED = new Set<string>();

mock.module('@tabs/admin/lib/users', {
  namedExports: {
    getPublicUser: async (id: string) => USERS[id] ?? null,
    authenticate: async () => null,
  },
});
mock.module('@tabs/admin/lib/domains', {
  namedExports: { activeDomainIds: (ids: string[]) => ids.filter((d) => !ARCHIVED.has(d)) },
});

const { resolveMcpUser, signMcpToken } = await import('./token.ts');

beforeEach(() => {
  USERS = { mia: { id: 'mia', name: 'Mia', domains: ['sales', 'ops'], role: 'builder' } };
  ARCHIVED.clear();
});

test('a valid token resolves the live user with all their domains', async () => {
  const u = await resolveMcpUser(signMcpToken('mia'));
  assert.equal(u?.id, 'mia');
  assert.deepEqual(u?.domains, ['sales', 'ops']);
});

test('a deactivated user’s token stops working', async () => {
  USERS.mia.disabled = true;
  assert.equal(await resolveMcpUser(signMcpToken('mia')), null);
});

test('an archived domain leaves the token’s scope, as it leaves the browser session', async () => {
  ARCHIVED.add('ops');
  const u = await resolveMcpUser(signMcpToken('mia'));
  assert.deepEqual(u?.domains, ['sales']);
  assert.deepEqual(u?.allDomains, ['sales']);
});

test('unchanged: an account that has not finished first sign-in is refused', async () => {
  USERS.mia.mustChangeCredentials = true;
  assert.equal(await resolveMcpUser(signMcpToken('mia')), null);
});

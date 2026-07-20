/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The pure token MINT (#146 Phase 2) against a FAKE admin client. Proves:
 *   - the response is the EXACT contract shape { token, username, expiresAt, scopes,
 *     forgejoBaseUrl } and nothing else,
 *   - default scope is the shared `analytics` repo; requested repos are filtered to
 *     the caller's domains (a repo outside the caller's domains is DROPPED),
 *   - the mirrored username is derived from the OS uid,
 *   - `expiresAt` = mint time + TTL (the token has a lifetime),
 *   - the mint SWEEPS the caller's prior OS-minted tokens (central revoke),
 *   - the minted token value NEVER appears in any log/console output during a mint,
 *   - an admin-client failure PROPAGATES (never a fabricated token).
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoAdminClient } from './forgejo-admin.ts';
import {
  mintToken,
  allowedRepos,
  forgejoScopes,
  tokenNamePrefix,
  ANALYTICS_REPO,
  type MintCaller,
} from './token-mint.ts';

const SECRET = 'gto_deadbeefdeadbeefdeadbeefdeadbeef';

// A fake admin client that records calls + returns a fixed token value.
function fakeAdmin(overrides: Partial<ForgejoAdminClient> = {}) {
  const calls = {
    ensured: [] as { username: string; email: string }[],
    created: [] as { username: string; name: string; scopes: string[] }[],
    swept: [] as { username: string; prefix: string }[],
  };
  const client: ForgejoAdminClient = {
    async ensureUser(username, email) { calls.ensured.push({ username, email }); },
    async createToken(username, name, scopes) {
      calls.created.push({ username, name, scopes });
      return { name, value: SECRET };
    },
    async deleteTokensByPrefix(username, prefix) {
      calls.swept.push({ username, prefix });
      return { deleted: 0 };
    },
    ...overrides,
  };
  return { client, calls };
}

const CFG = { forgejoBaseUrl: 'http://forgejo.example', ttlSeconds: 3600 };
const CALLER: MintCaller = { id: 'alex', domains: ['sales', 'marketing'] };
const NOW = 1_700_000_000_000;
const now = () => NOW;

let admin: ReturnType<typeof fakeAdmin>;
beforeEach(() => { admin = fakeAdmin(); });

test('allowedRepos: default scope is exactly [analytics]', () => {
  assert.deepEqual(allowedRepos(CALLER), [ANALYTICS_REPO]);
});

test('allowedRepos: requested repos filtered to caller domains; analytics always in', () => {
  const scoped = allowedRepos(CALLER, ['sales', 'finance', 'analytics']);
  assert.ok(scoped.includes('analytics'));
  assert.ok(scoped.includes('sales'), 'caller-domain repo kept');
  assert.ok(!scoped.includes('finance'), 'non-domain repo dropped (no leak, no error)');
});

test('forgejoScopes: coarse read+write repository', () => {
  assert.deepEqual(forgejoScopes(), ['read:repository', 'write:repository']);
});

test('mintToken returns the EXACT contract shape and nothing more', async () => {
  const res = await mintToken(admin.client, CALLER, CFG, { now });
  assert.deepEqual(Object.keys(res).sort(), ['expiresAt', 'forgejoBaseUrl', 'scopes', 'token', 'username'].sort());
  assert.equal(res.token, SECRET);
  assert.equal(res.username, 'os-alex');
  assert.deepEqual(res.scopes, [ANALYTICS_REPO]);
  assert.equal(res.forgejoBaseUrl, 'http://forgejo.example');
});

test('mintToken sets expiresAt = mint time + TTL (token has a lifetime)', async () => {
  const res = await mintToken(admin.client, CALLER, CFG, { now });
  assert.equal(res.expiresAt, new Date(NOW + 3600 * 1000).toISOString());
});

test('mintToken ensures the mirrored user, sweeps prior tokens, then mints AS it', async () => {
  await mintToken(admin.client, CALLER, CFG, { now });
  assert.equal(admin.calls.ensured[0].username, 'os-alex');
  // sweep BEFORE create, both for os-alex, with the OS-minted prefix
  assert.equal(admin.calls.swept[0].username, 'os-alex');
  assert.equal(admin.calls.swept[0].prefix, tokenNamePrefix('os-alex'));
  assert.equal(admin.calls.created[0].username, 'os-alex');
  assert.ok(admin.calls.created[0].name.startsWith(tokenNamePrefix('os-alex')));
  assert.deepEqual(admin.calls.created[0].scopes, forgejoScopes());
});

test('mintToken scope reflects requested repos, filtered to the caller domains', async () => {
  const res = await mintToken(admin.client, CALLER, CFG, { now, repos: ['marketing', 'secret-domain'] });
  assert.ok(res.scopes.includes('analytics'));
  assert.ok(res.scopes.includes('marketing'));
  assert.ok(!res.scopes.includes('secret-domain'));
});

test('mintToken never writes the token value to any log/console output', async () => {
  const seen: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((m) =>
    mock.method(console, m, (...args: unknown[]) => { seen.push(args.map(String).join(' ')); }),
  );
  try {
    const res = await mintToken(admin.client, CALLER, CFG, { now });
    assert.equal(res.token, SECRET); // token IS returned on the object …
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
  // … but never logged.
  assert.ok(!seen.join('\n').includes(SECRET), 'token value must never reach a log');
});

test('mintToken propagates an admin-client failure (never a fabricated token)', async () => {
  const failing = fakeAdmin({
    async createToken() { throw new Error('Forgejo createToken(os-alex) failed (500)'); },
  });
  await assert.rejects(mintToken(failing.client, CALLER, CFG, { now }), /createToken.*failed \(500\)/);
});

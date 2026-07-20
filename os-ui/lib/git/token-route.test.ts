/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The git token-mint ROUTE (#146 Phase 2) driven through the REAL handler, with
 * `requireUser`, `config`, and the real Forgejo admin client mocked. Proves:
 *   - anon (no session) → 401 and NOTHING is minted,
 *   - flag OFF → 403 "disabled" and NOTHING is minted,
 *   - a signed-in caller gets the EXACT contract { token, username, expiresAt,
 *     scopes, forgejoBaseUrl } scoped to their identity/domains,
 *   - the caller's identity comes from the SESSION, never the request body,
 *   - an admin-client failure surfaces as 502 with NO token in the error,
 *   - the minted token value never appears in any log during the request.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'gto_facefeedfacefeedfacefeedfacefeed';

// ─── mockable state ──────────────────────────────────────────────────────────
type User = { id: string; name: string; domains: string[]; role: string } | null;
let USER: User = { id: 'alex', name: 'Alex', domains: ['sales'], role: 'builder' };
let USER_STATUS = 0; // when non-zero, requireUser throws with this status (401/403)
let FLAG = true;
let ADMIN_FAILS = false;
const created: { username: string; name: string; scopes: string[] }[] = [];

mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => {
      if (USER_STATUS) {
        const err = new Error(USER_STATUS === 401 ? 'Not authenticated' : 'Forbidden') as Error & { status?: number };
        err.status = USER_STATUS;
        throw err;
      }
      return USER;
    },
  },
});
// LIVE config view: flag is a getter over mutable FLAG (a module can be mocked once).
mock.module('@/lib/core/config', {
  namedExports: {
    config: {
      get gitTokenMintEnabled() { return FLAG; },
      gitTokenTtlSeconds: 3600,
      forgejoConsoleUrl: 'http://forgejo.example',
      forgejoUrl: 'http://forgejo-http:3000',
    },
  },
});
// The real admin client is replaced with a fake that records createToken calls.
mock.module('@/lib/git/live-clients', {
  namedExports: {
    realForgejoAdmin: () => ({
      async ensureUser() {},
      async createToken(username: string, name: string, scopes: string[]) {
        if (ADMIN_FAILS) throw new Error('Forgejo createToken(os-alex) failed (500)');
        created.push({ username, name, scopes });
        return { name, value: SECRET };
      },
      async deleteTokensByPrefix() { return { deleted: 0 }; },
    }),
  },
});

const { POST } = await import('../../app/api/git/token/route.ts');

const reqWith = (body?: unknown) =>
  new Request('http://os/api/git/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  USER = { id: 'alex', name: 'Alex', domains: ['sales'], role: 'builder' };
  USER_STATUS = 0;
  FLAG = true;
  ADMIN_FAILS = false;
  created.length = 0;
});

test('anon (no session) → 401, nothing minted', async () => {
  USER_STATUS = 401;
  const res = await POST(reqWith());
  assert.equal(res.status, 401);
  assert.equal(created.length, 0);
});

test('flag OFF → 403 disabled, nothing minted', async () => {
  FLAG = false;
  const res = await POST(reqWith());
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /disabled/i);
  assert.equal(created.length, 0);
});

test('signed-in caller → 200 with the EXACT contract shape', async () => {
  const res = await POST(reqWith());
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'forgejoBaseUrl', 'scopes', 'token', 'username'].sort());
  assert.equal(body.token, SECRET);
  assert.equal(body.username, 'os-alex');
  assert.deepEqual(body.scopes, ['analytics']);
  assert.equal(body.forgejoBaseUrl, 'http://forgejo.example');
  assert.equal(typeof body.expiresAt, 'string');
});

test('identity comes from the SESSION, not the request body', async () => {
  // A body claiming another uid must NOT change who the token is minted for.
  const res = await POST(reqWith({ id: 'someone-else', domains: ['finance'] }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { username: string };
  assert.equal(body.username, 'os-alex'); // still the session user
  assert.equal(created[0].username, 'os-alex');
});

test('requested repos are scoped to the caller domains', async () => {
  USER = { id: 'alex', name: 'Alex', domains: ['sales', 'marketing'], role: 'builder' };
  const res = await POST(reqWith({ repos: ['marketing', 'finance'] }));
  const body = (await res.json()) as { scopes: string[] };
  assert.ok(body.scopes.includes('marketing'));
  assert.ok(!body.scopes.includes('finance'));
});

test('admin-client failure → 502 and NO token in the error body', async () => {
  ADMIN_FAILS = true;
  const res = await POST(reqWith());
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes(SECRET), 'error body must not contain a token');
});

test('the token value never appears in any log during the request', async () => {
  const seen: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((m) =>
    mock.method(console, m, (...args: unknown[]) => { seen.push(args.map(String).join(' ')); }),
  );
  try {
    const res = await POST(reqWith());
    assert.equal(res.status, 200);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
  assert.ok(!seen.join('\n').includes(SECRET), 'token value must never reach a log');
});

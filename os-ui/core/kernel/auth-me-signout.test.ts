/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A deactivated or deleted user holding a still-valid cookie is signed out cleanly
 * USER STORY: As an admin who deactivated someone I want their open browser signed out at once —
 *             a clean sign-out to /signin, not a half-working app or a redirect loop.
 * ARCHITECTURE:
 *   - The REAL `GET /api/auth/me` route; `currentUser` is stubbed (its own rules are proven in
 *     auth-live-domains.test.ts). A cookie that no longer maps to a live user → `{ user: null,
 *     signedOut: true }` and the session cookie EXPIRED in the response, so the middleware sends the
 *     next navigation to /signin and AuthGate goes there now (no cookie → no loop).
 *   - Twins: no cookie at all → plain `{ user: null }`, nothing expired; a live user → no expiry.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookieName } from '@core/kernel/session';

const state = { token: undefined as string | undefined, user: null as null | { id: string } };
mock.module('next/headers', {
  namedExports: {
    cookies: async () => ({ get: (n: string) => (n === sessionCookieName() && state.token ? { value: state.token } : undefined) }),
  },
});
mock.module('@core/kernel/auth', {
  namedExports: { currentUser: async () => (state.user ? { ...state.user, name: 'x', domains: [], allDomains: [], activeDomain: null, role: 'creator' } : null) },
});
mock.module('@tabs/admin/lib/users', { namedExports: { getPublicUser: async () => ({ onboarded: true }) } });

const route = () => import(`../../app/api/auth/me/route.ts?${Math.random()}`);
const expired = (res: Response) => (res.headers.get('set-cookie') ?? '').includes(`${sessionCookieName()}=;`);

beforeEach(() => { state.token = undefined; state.user = null; });

test('a valid cookie with no live user (deactivated / deleted) → signedOut and the cookie expired', async () => {
  state.token = 'still-valid-cookie';
  const res = await (await route()).GET();
  const body = await res.json();
  assert.equal(body.user, null);
  assert.equal(body.signedOut, true);
  assert.ok(expired(res), 'the session cookie is expired in the response');
});

test('twin: no cookie at all → user null, nothing to sign out', async () => {
  const res = await (await route()).GET();
  const body = await res.json();
  assert.equal(body.user, null);
  assert.equal(body.signedOut, undefined);
  assert.ok(!expired(res));
});

test('twin: a live user → no sign-out', async () => {
  state.token = 'cookie';
  state.user = { id: 'nova-admin' };
  const res = await (await route()).GET();
  assert.equal((await res.json()).user.id, 'nova-admin');
  assert.ok(!expired(res));
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The signed-in user's domains are the user directory's, as they are NOW
 * USER STORY: As an admin who just created a domain and added myself (or anyone) to it, I want it
 *             in my sidebar domain dropdown straight away, not after the next sign-in. And a member
 *             taken out of a domain must lose it straight away too.
 * ARCHITECTURE:
 *   - The REAL `currentUser()` and a REAL signed session cookie; only `next/headers` (the cookie
 *     jar) and the user directory (`getPublicUser`) are stubbed.
 *   - Bug (dev, 2026-11-24): the session cookie is signed at login with the user's domains, and
 *     `currentUser()` scoped on that snapshot. A domain created and joined after login never
 *     reached `/api/auth/me` → the dropdown.
 *   - Negative twins: a removed membership disappears; a domain the directory never gave the user
 *     never appears (not even via the active-domain cookie); no directory record → the signed
 *     session stays the scope (no widening); a failing directory read fails loudly.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, sessionCookieName } from '@core/kernel/session';
import { ACTIVE_DOMAIN_COOKIE } from '@core/kernel/active-domain';
import { config } from '@core/kernel/config';

type Live = { id: string; name: string; role: 'admin' | 'builder' | 'creator' | 'domain_admin'; domains: string[]; disabled?: boolean } | null;
const state = { token: undefined as string | undefined, active: undefined as string | undefined, live: null as Live, throws: false };

mock.module('next/headers', {
  namedExports: {
    cookies: async () => ({
      get: (n: string) => {
        if (n === sessionCookieName() && state.token) return { value: state.token };
        if (n === ACTIVE_DOMAIN_COOKIE && state.active) return { value: state.active };
        return undefined;
      },
    }),
  },
});
mock.module('@tabs/admin/lib/users', {
  namedExports: {
    authenticate: async () => null,
    getPublicUser: async () => {
      if (state.throws) throw new Error('store unavailable');
      return state.live;
    },
    // The directory's own rule (stand-in): reserved principals have no public directory record.
    isReserved: (id: string) => id.startsWith('__'),
  },
});

const { currentUser } = await import('@core/kernel/auth');

async function signIn(domains: string[], id = 'nova-admin') {
  state.token = await signSession({ id, name: 'Nova', domains, role: 'admin' }, config.sessionSecret);
}

beforeEach(() => {
  state.token = undefined;
  state.active = undefined;
  state.live = null;
  state.throws = false;
});

test('a domain joined after sign-in is in allDomains (the dropdown) without signing in again', async () => {
  await signIn(['platform', 'sales']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform', 'sales', 'data-masterclass'] };
  const u = await currentUser();
  assert.ok(u);
  assert.deepEqual(u.allDomains, ['platform', 'sales', 'data-masterclass']);
  assert.deepEqual(u.domains, ['platform', 'sales', 'data-masterclass']);
});

test('the new domain can be chosen as the active domain right away', async () => {
  await signIn(['platform']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform', 'data-masterclass'] };
  state.active = 'data-masterclass';
  const u = await currentUser();
  assert.equal(u?.activeDomain, 'data-masterclass');
  assert.deepEqual(u?.domains, ['data-masterclass']);
});

test('negative twin: a membership removed after sign-in is gone at once', async () => {
  await signIn(['platform', 'sales']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'] };
  state.active = 'sales';
  const u = await currentUser();
  assert.deepEqual(u?.allDomains, ['platform']);
  assert.equal(u?.activeDomain, null, 'the stale active-domain cookie cannot keep the removed domain');
  assert.deepEqual(u?.domains, ['platform']);
});

test('negative twin: a domain the directory never gave the user never appears', async () => {
  await signIn(['platform']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'] };
  state.active = 'acme-secret';
  const u = await currentUser();
  assert.deepEqual(u?.allDomains, ['platform']);
  assert.equal(u?.activeDomain, null);
});

test('a reserved principal without a directory record → the signed session stays the scope', async () => {
  await signIn(['platform', 'sales'], '__bootstrap');
  state.live = null;
  const u = await currentUser();
  assert.deepEqual(u?.allDomains, ['platform', 'sales']);
  assert.equal(u?.role, 'admin');
});

test('F2: a deleted (non-reserved) user has no session, though the cookie is still valid', async () => {
  await signIn(['platform', 'sales']);
  state.live = null;
  assert.equal(await currentUser(), null);
});

test('F1: a deactivated user has no session, though the cookie is still valid', async () => {
  await signIn(['platform']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'], disabled: true };
  assert.equal(await currentUser(), null);
  // twin: the same user, active again → signed in
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'] };
  assert.equal((await currentUser())?.id, 'nova-admin');
});

test('role is the directory\'s, now: a demotion after sign-in takes effect at once', async () => {
  await signIn(['platform']);
  state.live = { id: 'nova-admin', name: 'Nova', role: 'builder', domains: ['platform'] };
  assert.equal((await currentUser())?.role, 'builder');
  // twin: unchanged directory role → the same role
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'] };
  assert.equal((await currentUser())?.role, 'admin');
});

test('a directory that fails to read fails the request — no silent guess at the domains', async () => {
  await signIn(['platform', 'sales']);
  state.throws = true;
  await assert.rejects(currentUser(), /store unavailable/);
});

test('no session → no user, whatever the directory says', async () => {
  state.live = { id: 'nova-admin', name: 'Nova', role: 'admin', domains: ['platform'] };
  assert.equal(await currentUser(), null);
});

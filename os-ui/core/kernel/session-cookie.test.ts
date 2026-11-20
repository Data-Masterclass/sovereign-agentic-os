/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Tests for the host-only OS session cookie
 * USER STORY:   As a user, my OS session cookie is never sent to any other host, including deployed apps.
 * ARCHITECTURE: Unit tests of sessionCookieOptions / legacySessionCookieExpiry in core/kernel/session.ts.
 */
/**
 * The OS session cookie is HOST-ONLY: no `Domain` attribute, so the browser sends it
 * to the OS host and never to the apps domain or any other subdomain. Older releases
 * widened it to a parent Domain; login / bootstrap / logout expire that legacy copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacySessionCookieExpiry, sessionCookieOptions, SESSION_COOKIE } from '@core/kernel/session';

const OS = 'https://agentic.datamasterclass.com';
const APPS = 'apps.agentic.datamasterclass.com';

test('session cookie is host-only, HttpOnly, SameSite=Lax, Secure in production', () => {
  const opts = sessionCookieOptions({ maxAge: 42, isProd: true });
  assert.equal('domain' in opts, false, 'no Domain attribute → host-only');
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, 'lax');
  assert.equal(opts.secure, true);
  assert.equal(opts.path, '/');
  assert.equal(opts.maxAge, 42);
});

test('negative twin: no input can widen the cookie (the old osPublicUrl/appsDomain inputs are gone)', () => {
  // Even when callers pass the deployment's real hosts, no Domain is produced.
  const opts = sessionCookieOptions({ osPublicUrl: OS, appsDomain: APPS, isProd: true } as never);
  assert.equal('domain' in opts, false);
});

test('the apps domain is a child of the OS host in prod — exactly why a parent Domain is unsafe', () => {
  const osHost = new URL(OS).hostname;
  assert.ok(APPS.endsWith(`.${osHost}`), 'apps hosts sit under the OS host');
  assert.ok(!osHost.endsWith(`.${APPS}`), 'the apps domain is not a parent of the OS host');
});

test('legacy expiry clears the cookie an older release set on the parent Domain', () => {
  const sc = legacySessionCookieExpiry({ osPublicUrl: OS, appsDomain: APPS, isProd: true });
  assert.ok(sc);
  assert.ok(sc!.startsWith(`${SESSION_COOKIE}=;`));
  assert.match(sc!, /Domain=\.agentic\.datamasterclass\.com/);
  assert.match(sc!, /Max-Age=0/);
  assert.match(sc!, /Secure/);
  assert.match(sc!, /HttpOnly/);
});

test('legacy expiry is null where no parent Domain was ever derivable', () => {
  assert.equal(legacySessionCookieExpiry({ osPublicUrl: '', appsDomain: 'apps.local' }), null);
  assert.equal(legacySessionCookieExpiry({ osPublicUrl: 'http://localhost:3000', appsDomain: 'apps.local' }), null);
  assert.equal(legacySessionCookieExpiry({ osPublicUrl: 'https://os.foo.com', appsDomain: 'apps.bar.com' }), null);
});

test('OS_SESSION_COOKIE_INSECURE=true drops Secure in production (plain-http local dev)', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.OS_SESSION_COOKIE_INSECURE;
  try {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.OS_SESSION_COOKIE_INSECURE;
    assert.equal(sessionCookieOptions({}).secure, true);
    process.env.OS_SESSION_COOKIE_INSECURE = 'true';
    assert.equal(sessionCookieOptions({}).secure, false);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
    if (prevFlag === undefined) delete process.env.OS_SESSION_COOKIE_INSECURE;
    else process.env.OS_SESSION_COOKIE_INSECURE = prevFlag;
  }
});

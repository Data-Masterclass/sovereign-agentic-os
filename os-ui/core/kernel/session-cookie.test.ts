/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Tests for the host-only OS session cookie
 * USER STORY:   As a user, my OS session cookie is never sent to any other host, including deployed apps.
 * ARCHITECTURE: Unit tests of sessionCookieOptions / sessionTokenFrom / legacySessionCookieExpiries in core/kernel/session.ts.
 */
/**
 * The OS session cookie is HOST-ONLY: no `Domain` attribute, so the browser sends it
 * to the OS host and never to the apps domain or any other subdomain. Older releases
 * widened it to a parent Domain; login / bootstrap / logout expire that legacy copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSECURE_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  legacySessionCookieExpiries,
  sessionCookieName,
  sessionCookieOptions,
  sessionTokenFrom,
  SESSION_COOKIE,
} from '@core/kernel/session';

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

test('the session cookie is named __Host- (browser-enforced: Secure, Path=/, no Domain)', () => {
  assert.equal(SESSION_COOKIE, '__Host-soa_session');
  assert.equal(sessionCookieName(true), '__Host-soa_session');
  // Every __Host- requirement holds for the options we set it with.
  const o = sessionCookieOptions({ isProd: true });
  assert.equal(o.secure, true);
  assert.equal(o.path, '/');
  assert.equal('domain' in o, false);
});

test('plain-http dev (no Secure) uses a different, non-legacy name — never soa_session', () => {
  assert.equal(sessionCookieName(false), INSECURE_SESSION_COOKIE);
  assert.notEqual(sessionCookieName(false), LEGACY_SESSION_COOKIE);
});

test('a parent-domain / tossed legacy soa_session is IGNORED', () => {
  const jar = new Map([[LEGACY_SESSION_COOKIE, 'a-valid-looking-token']]);
  assert.equal(sessionTokenFrom((n) => jar.get(n), true), undefined);
  assert.equal(sessionTokenFrom((n) => jar.get(n), false), undefined);
});

test('negative twin: the __Host- cookie IS read, even when a legacy one is also present', () => {
  const jar = new Map([
    [LEGACY_SESSION_COOKIE, 'tossed'],
    [SESSION_COOKIE, 'real'],
  ]);
  assert.equal(sessionTokenFrom((n) => jar.get(n), true), 'real');
  assert.equal(sessionTokenFrom(() => '', true), undefined, 'an empty value is no session');
});

test('legacy expiries clear soa_session host-only AND on the old parent Domain', () => {
  const sc = legacySessionCookieExpiries({ osPublicUrl: OS, appsDomain: APPS, isProd: true });
  assert.equal(sc.length, 2);
  for (const c of sc) {
    assert.ok(c.startsWith(`${LEGACY_SESSION_COOKIE}=;`));
    assert.match(c, /Max-Age=0/);
    assert.match(c, /Secure/);
  }
  assert.ok(!/Domain=/.test(sc[0]));
  assert.match(sc[1], /Domain=\.agentic\.datamasterclass\.com/);
});

test('legacy expiry is host-only where no parent Domain was ever derivable', () => {
  for (const o of [
    { osPublicUrl: '', appsDomain: 'apps.local' },
    { osPublicUrl: 'http://localhost:3000', appsDomain: 'apps.local' },
    { osPublicUrl: 'https://os.foo.com', appsDomain: 'apps.bar.com' },
  ]) {
    const sc = legacySessionCookieExpiries(o);
    assert.equal(sc.length, 1);
    assert.ok(!/Domain=/.test(sc[0]));
  }
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

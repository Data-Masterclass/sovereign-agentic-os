/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the cross-subdomain session-cookie scoping (identity delegation / SSO).
 * The OS session cookie must reach BOTH the OS host and the per-app subdomains
 * (`<slug>.<domain>.<appsDomain>`), so it is scoped to their shared parent domain.
 * It must NEVER widen to a bare TLD or an unrelated deployment, and must stay
 * host-only (null) when the deployment isn't cross-subdomain (local dev).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookieDomain, sessionCookieOptions } from './session.ts';

test('shared parent domain: OS + apps under the same registrable domain', () => {
  assert.equal(
    sessionCookieDomain('https://agentic.datamasterclass.com', 'apps.datamasterclass.com'),
    '.datamasterclass.com',
  );
});

test('apps domain nested deeper still resolves the common parent', () => {
  assert.equal(
    sessionCookieDomain('https://os.acme.io', 'run.apps.acme.io'),
    '.acme.io',
  );
});

test('bare host (no scheme) for the OS URL is accepted', () => {
  assert.equal(
    sessionCookieDomain('agentic.datamasterclass.com', 'apps.datamasterclass.com'),
    '.datamasterclass.com',
  );
});

test('no OS public URL → host-only (null): local dev / same-origin is unchanged', () => {
  assert.equal(sessionCookieDomain('', 'apps.datamasterclass.com'), null);
  assert.equal(sessionCookieDomain(undefined, 'apps.local'), null);
});

test('localhost / IP hosts are never widened', () => {
  assert.equal(sessionCookieDomain('http://localhost:3000', 'apps.local'), null);
  assert.equal(sessionCookieDomain('http://127.0.0.1:3000', 'apps.local'), null);
});

test('unrelated OS + apps domains share no ≥2-label parent → null (never widen wrongly)', () => {
  // Only ".com" is shared — a bare TLD — so we refuse to widen the cookie.
  assert.equal(sessionCookieDomain('https://os.foo.com', 'apps.bar.com'), null);
  // No overlap at all.
  assert.equal(sessionCookieDomain('https://os.foo.com', 'apps.bar.net'), null);
});

test('sessionCookieOptions carries the derived Domain + secure hardening', () => {
  const opts = sessionCookieOptions({
    osPublicUrl: 'https://agentic.datamasterclass.com',
    appsDomain: 'apps.datamasterclass.com',
    maxAge: 42,
    isProd: true,
  });
  assert.equal(opts.domain, '.datamasterclass.com');
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, 'lax');
  assert.equal(opts.secure, true);
  assert.equal(opts.path, '/');
  assert.equal(opts.maxAge, 42);
});

test('sessionCookieOptions omits Domain entirely when not derivable (host-only)', () => {
  const opts = sessionCookieOptions({ osPublicUrl: '', appsDomain: 'apps.local', isProd: false });
  assert.equal('domain' in opts, false, 'no domain key → host-only cookie, OS login unaffected');
  assert.equal(opts.secure, false);
});

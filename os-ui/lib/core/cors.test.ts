/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the credentialed CORS allow-list used by deployed governed apps that
 * call back into the OS (identity delegation). Only the OS's own origin and hosts
 * under the apps domain are reflected — never `*`, never an arbitrary origin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeadersFor, isAllowedAppOrigin } from './cors.ts';

const OS = 'https://agentic.datamasterclass.com';
const APPS = 'apps.datamasterclass.com';

test('an app subdomain under the apps domain is allowed', () => {
  assert.equal(isAllowedAppOrigin('https://ops-hub.finance.apps.datamasterclass.com', OS, APPS), true);
});

test('the apps domain apex itself is allowed', () => {
  assert.equal(isAllowedAppOrigin('https://apps.datamasterclass.com', OS, APPS), true);
});

test("the OS's own origin is allowed (host-compare)", () => {
  assert.equal(isAllowedAppOrigin('https://agentic.datamasterclass.com', OS, APPS), true);
});

test('an unrelated origin is REJECTED (no wildcard, no arbitrary echo)', () => {
  assert.equal(isAllowedAppOrigin('https://evil.example.com', OS, APPS), false);
  // A look-alike suffix that is not actually under the apps domain.
  assert.equal(isAllowedAppOrigin('https://apps.datamasterclass.com.evil.com', OS, APPS), false);
});

test('a missing/garbage origin is rejected', () => {
  assert.equal(isAllowedAppOrigin(null, OS, APPS), false);
  assert.equal(isAllowedAppOrigin('', OS, APPS), false);
  assert.equal(isAllowedAppOrigin('not-a-url', OS, APPS), false);
});

test('corsHeadersFor reflects the exact origin with credentials (never *)', () => {
  const origin = 'https://ops-hub.finance.apps.datamasterclass.com';
  const h = corsHeadersFor(origin, OS, APPS);
  assert.ok(h);
  assert.equal(h!['Access-Control-Allow-Origin'], origin);
  assert.notEqual(h!['Access-Control-Allow-Origin'], '*');
  assert.equal(h!['Access-Control-Allow-Credentials'], 'true');
  assert.match(h!['Vary'], /Origin/);
});

test('corsHeadersFor returns null for a disallowed origin (add nothing)', () => {
  assert.equal(corsHeadersFor('https://evil.example.com', OS, APPS), null);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Credentialed CORS is granted to the OS's OWN public origin only (exact match).
 * No other origin — apps-domain hosts, look-alikes, other schemes/ports — is ever
 * reflected, and `*` is never used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeadersFor, isAllowedAppOrigin } from '@core/kernel/cors';

const OS = 'https://agentic.datamasterclass.com';
const APPS = 'apps.agentic.datamasterclass.com';

test("the OS's own origin gets the credentialed grant", () => {
  const h = corsHeadersFor(OS, OS);
  assert.ok(h);
  assert.equal(h!['Access-Control-Allow-Origin'], OS);
  assert.equal(h!['Access-Control-Allow-Credentials'], 'true');
  assert.match(h!['Vary'], /Origin/);
});

test('an app subdomain gets NO CORS grant (no reflection, no credentials)', () => {
  assert.equal(corsHeadersFor('https://x.apps.agentic.datamasterclass.com', OS), null);
  assert.equal(corsHeadersFor('https://ops-hub.finance.apps.agentic.datamasterclass.com', OS), null);
  assert.equal(corsHeadersFor('https://apps.agentic.datamasterclass.com', OS), null);
});

test('look-alike origins get NO CORS grant', () => {
  for (const o of [
    'https://agentic.datamasterclass.com.evil.example',
    'https://evil-agentic.datamasterclass.com',
    'http://agentic.datamasterclass.com',
    'https://agentic.datamasterclass.com:8443',
    'https://AGENTIC.datamasterclass.com/', // not a serialized Origin
    'null',
    '*',
  ]) {
    assert.equal(corsHeadersFor(o, OS), null, o);
  }
});

test('no OS public URL configured → no CORS grant for anyone', () => {
  assert.equal(corsHeadersFor('http://localhost:3000', ''), null);
  assert.equal(corsHeadersFor('http://localhost:3000', undefined), null);
});

test('missing / garbage origin → null', () => {
  assert.equal(corsHeadersFor(null, OS), null);
  assert.equal(corsHeadersFor('', OS), null);
  assert.equal(corsHeadersFor('not-a-url', OS), null);
});

test('isAllowedAppOrigin still ATTRIBUTES apps-domain hosts (least-privilege narrowing only)', () => {
  assert.equal(isAllowedAppOrigin('https://ops-hub.finance.apps.agentic.datamasterclass.com', OS, APPS), true);
  assert.equal(isAllowedAppOrigin('https://apps.agentic.datamasterclass.com.evil.com', OS, APPS), false);
  assert.equal(isAllowedAppOrigin(null, OS, APPS), false);
});

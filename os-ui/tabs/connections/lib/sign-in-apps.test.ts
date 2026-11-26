/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    "Accounts for the chat" says plainly when a provider's sign-in app is missing, and where to set it up
 * USER STORY: As an admin who just added Microsoft 365 I want to be told that the Microsoft sign-in app is the
 *             next step, with a button to it, instead of a row that looks finished; as a creator I want to know
 *             whom to ask. As anyone I want the page to have ONE name wherever it is mentioned.
 * ARCHITECTURE:
 *   - Exercises tabs/connections/lib/sign-in-apps.ts, the pure module AccountConnections.tsx renders from
 *     (a test cannot import a .tsx). The link target is checked against the page on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  SIGN_IN_APPS_NAME, SIGN_IN_APPS_HREF, signInProvider, providerName, signInAppsStatus,
  missingSignInAppNotice, addedNotice,
} from '@tabs/connections/lib/sign-in-apps';
import { REGISTRIES } from '@tabs/connections/lib/registries';

test('one name: the Connections registry card uses it, and the link opens the existing page', () => {
  assert.equal(SIGN_IN_APPS_NAME, 'Sign-in apps (Google & Microsoft)');
  assert.equal(SIGN_IN_APPS_HREF, '/platform/oauth-apps', 'the URL stays, so no bookmark breaks');
  assert.ok(existsSync('app/(govern)/platform/oauth-apps/page.tsx'));
  const card = REGISTRIES.find((r) => r.id === 'oauth-apps');
  assert.equal(card?.label, SIGN_IN_APPS_NAME);
  assert.equal(card?.href, SIGN_IN_APPS_HREF);
  assert.match(card?.sub ?? '', /drives and mail/);
});

test('each account kind and template maps to the provider whose sign-in app it needs', () => {
  assert.equal(signInProvider('microsoft-365'), 'microsoft');
  assert.equal(signInProvider('onedrive'), 'microsoft');
  assert.equal(signInProvider('gdrive'), 'google');
  assert.equal(signInProvider('notion'), null, 'Notion signs in through its own MCP, no admin app');
  assert.equal(signInProvider('notion-mcp'), null);
  assert.equal(providerName('microsoft'), 'Microsoft');
  assert.equal(providerName('google'), 'Google');
});

test('signInAppsStatus reports only booleans per provider: no client id or secret leaves the server', () => {
  const s = signInAppsStatus((p) => p === 'google');
  assert.deepEqual(s, { google: true, microsoft: false });
});

test('missing app, admin: a warning with a direct "Set up the sign-in app" link', () => {
  const n = missingSignInAppNotice('microsoft-365', 'admin');
  assert.equal(n.text, "Can't connect yet: the Microsoft sign-in app isn't set up.");
  assert.deepEqual(n.action, { label: 'Set up the sign-in app', href: '/platform/oauth-apps' });
});

test('TWIN: missing app, not an admin: whom to ask, and no link to a page they would be bounced from', () => {
  for (const role of ['creator', 'builder', 'domain_admin'] as const) {
    const n = missingSignInAppNotice('gdrive', role);
    assert.equal(n.text, "Can't connect yet: the Google sign-in app isn't set up. Ask your admin to set up the Google sign-in app.");
    assert.equal(n.action, undefined, `${role} must not get the admin-only link`);
  }
});

test('after adding: the next step when the provider app is missing, nothing when it is set up or not needed', () => {
  const apps = { google: true, microsoft: false };
  const n = addedNotice('microsoft-365', apps, 'admin');
  assert.ok(n);
  assert.equal(n.text, 'Added. Next step: set up the Microsoft sign-in app.');
  assert.deepEqual(n.action, { label: 'Set up the sign-in app', href: '/platform/oauth-apps' });
  assert.equal(addedNotice('onedrive', apps, 'admin')?.text, 'Added. Next step: set up the Microsoft sign-in app.');
  assert.equal(addedNotice('gdrive', apps, 'admin'), null, 'Google is set up: the row offers Connect, no notice');
  assert.equal(addedNotice('notion', apps, 'admin'), null);
});

test('TWIN: after adding as a domain admin: the next step names the admin, without the admin-only link', () => {
  const n = addedNotice('microsoft-365', { google: false, microsoft: false }, 'domain_admin');
  assert.equal(n?.text, 'Added. Next step: ask your admin to set up the Microsoft sign-in app.');
  assert.equal(n?.action, undefined);
});

test('TWIN: an unknown sign-in status (list not loaded) is treated as missing, never as ready', () => {
  assert.equal(addedNotice('gdrive', null, 'admin')?.text, 'Added. Next step: set up the Google sign-in app.');
});

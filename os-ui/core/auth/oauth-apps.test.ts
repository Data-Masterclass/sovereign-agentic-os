/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerOAuthApp, getOAuthApp, getClientCredentials, isConfigured, listOAuthApps, providerCatalog, _reset } from '@core/auth/oauth-apps';

beforeEach(() => _reset());

test('register stores a ref + fingerprint but NEVER the raw client secret in the record', async () => {
  const app = await registerOAuthApp({ provider: 'google', clientId: 'gcid.apps.googleusercontent.com', clientSecret: 'super-secret-value', addedBy: 'admin' });
  assert.equal(app.provider, 'google');
  assert.equal(app.clientId, 'gcid.apps.googleusercontent.com');
  assert.ok(app.fingerprint.startsWith('hmac-sha256:'));
  // the record must not carry the raw secret anywhere
  assert.equal(JSON.stringify(app).includes('super-secret-value'), false);
  assert.ok(isConfigured('google'));
});

test('getClientCredentials returns the secret SERVER-SIDE for the exchange', async () => {
  await registerOAuthApp({ provider: 'microsoft', clientId: 'azure-app-id', clientSecret: 'azure-secret', addedBy: 'admin' });
  const creds = getClientCredentials('microsoft');
  assert.equal(creds?.clientId, 'azure-app-id');
  assert.equal(creds?.clientSecret, 'azure-secret');
  // unconfigured provider → null (no leak, no throw)
  assert.equal(getClientCredentials('google'), null);
});

test('validation: client id and secret are required', async () => {
  await assert.rejects(() => registerOAuthApp({ provider: 'google', clientId: '', clientSecret: 's', addedBy: 'a' }), /client id/);
  await assert.rejects(() => registerOAuthApp({ provider: 'google', clientId: 'c', clientSecret: '', addedBy: 'a' }), /client secret/);
});

test('catalog reflects configured state + minimal scopes for the admin UI', async () => {
  await registerOAuthApp({ provider: 'google', clientId: 'c', clientSecret: 's', addedBy: 'a' });
  const cat = providerCatalog();
  const g = cat.find((c) => c.provider === 'google');
  const m = cat.find((c) => c.provider === 'microsoft');
  assert.equal(g?.configured, true);
  assert.equal(m?.configured, false);
  assert.deepEqual(g?.scopes, ['https://www.googleapis.com/auth/drive.readonly']);
  // Microsoft: the drive's minimal read + what Microsoft 365 asks (read-only; registered once on the Entra app).
  for (const sc of ['Files.Read', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read', 'Sites.Read.All', 'Chat.Read']) assert.ok(m?.scopes.includes(sc), sc);
  assert.equal(m?.scopes.some((sc) => /Write|Send/.test(sc)), false);
  assert.equal(listOAuthApps().length, 1);
  assert.equal(getOAuthApp('google')?.clientId, 'c');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publicBaseUrl, callbackUri, safeReturnTo } from '@core/auth/redirect';
import { scopesForTemplate, providerForTemplate } from '@core/auth/providers';

afterEach(() => { delete process.env.OS_PUBLIC_URL; });

test('publicBaseUrl prefers OS_PUBLIC_URL, else the request origin', () => {
  process.env.OS_PUBLIC_URL = 'https://agentic.datamasterclass.com/';
  assert.equal(publicBaseUrl('http://localhost:3000/api/x'), 'https://agentic.datamasterclass.com');
  delete process.env.OS_PUBLIC_URL;
  assert.equal(publicBaseUrl('http://localhost:3000/api/x'), 'http://localhost:3000');
});

test('callbackUri builds the exact registered redirect URI', () => {
  const base = 'https://agentic.datamasterclass.com';
  assert.equal(callbackUri(base, 'google'), 'https://agentic.datamasterclass.com/api/connections/oauth/google/callback');
  assert.equal(callbackUri(base, 'microsoft'), 'https://agentic.datamasterclass.com/api/connections/oauth/microsoft/callback');
});

test('safeReturnTo keeps an OS path and refuses anything that could leave the OS', () => {
  assert.equal(safeReturnTo('/'), '/');
  assert.equal(safeReturnTo('/connections?x=1'), '/connections?x=1');
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, 'relative', `/${'a'.repeat(400)}`]) {
    assert.equal(safeReturnTo(bad as string | null), null, String(bad));
  }
});

test('each account template asks for its own read scopes', () => {
  assert.equal(providerForTemplate('microsoft-365'), 'microsoft');
  const m365 = scopesForTemplate('microsoft-365');
  for (const s of ['Mail.Read', 'Calendars.Read', 'Files.Read.All', 'Sites.Read.All', 'Chat.Read', 'offline_access', 'User.Read']) assert.ok(m365.includes(s), s);
  assert.equal(m365.some((s) => /ReadWrite|Send/.test(s)), false, 'read-only');
  assert.deepEqual(scopesForTemplate('onedrive'), ['Files.Read', 'offline_access', 'User.Read']);
  assert.deepEqual(scopesForTemplate('gdrive'), ['https://www.googleapis.com/auth/drive.readonly']);
});

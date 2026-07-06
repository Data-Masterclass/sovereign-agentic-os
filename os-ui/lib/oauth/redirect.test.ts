/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publicBaseUrl, callbackUri } from './redirect.ts';

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

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveConnectionStatus, driveAuthorizePath } from './drive-status.ts';
import { providerForTemplate } from './providers.ts';

test('status: a freshly created (untested) drive reads Not connected', () => {
  assert.equal(driveConnectionStatus({ health: 'untested' }), 'not-connected');
});

test('status: a healthy drive (token stored via consent) reads Connected', () => {
  assert.equal(driveConnectionStatus({ health: 'healthy' }), 'connected');
});

test('status: a drive whose silent refresh failed reads needs-reconnect', () => {
  assert.equal(driveConnectionStatus({ health: 'needs-reconnect' }), 'needs-reconnect');
});

test('authorize path targets the provider the template federates to, with an encoded id', () => {
  const g = providerForTemplate('gdrive')!;
  const m = providerForTemplate('onedrive')!;
  assert.equal(driveAuthorizePath(g, 'conn_abc'), '/api/connections/oauth/google/authorize?connectionId=conn_abc');
  assert.equal(driveAuthorizePath(m, 'conn_abc'), '/api/connections/oauth/microsoft/authorize?connectionId=conn_abc');
  // ids are URL-encoded so a funky id can never break out of the query
  assert.equal(driveAuthorizePath(g, 'a b&c'), '/api/connections/oauth/google/authorize?connectionId=a%20b%26c');
});

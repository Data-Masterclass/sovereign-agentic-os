/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * End-to-end wiring for the connected-drive OAuth flow at the connections layer:
 *   • the CALLBACK sink (`storeConnectionTokens`) persists the real token set;
 *   • the SYNC resolver (`resolveConnectionAccessToken`) hands that token back and
 *     selects the LIVE connector client (not the mock);
 *   • governance: only the connection OWNER can store/sync;
 *   • a stale token with no reachable refresh endpoint degrades to the mock.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Offline stub BEFORE importing connections.ts so getCache()/trace/refresh all run
// in-process (no OpenSearch, no network token endpoint).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, storeConnectionTokens, resolveConnectionAccessToken, __resetConnections } = await import('./store.ts');
const { liveClientFor } = await import('../files/connectors-live.ts');

const owner = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' as const };
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => __resetConnections());

async function makeDrive() {
  // A personal Google Drive connection — createConnection mints the offline
  // placeholder token (kind), which is NOT a real OAuth token set.
  return createConnection(owner, { name: 'My Drive', template: 'gdrive', endpoint: '', credential: '' });
}

test('before OAuth: the placeholder resolves to null → the sync uses the MOCK client', async () => {
  const conn = await makeDrive();
  const token = await resolveConnectionAccessToken(conn.id, owner.id);
  assert.equal(token, null);
  assert.equal(liveClientFor('google-drive', token).mode, 'mock');
});

test('callback stores the token; sync resolves it and selects the LIVE client', async () => {
  const conn = await makeDrive();
  await storeConnectionTokens(conn.id, owner.id, { accessToken: 'ya29.real-access', refreshToken: 'r1', expiresAt: nowSec() + 3600 });
  const token = await resolveConnectionAccessToken(conn.id, owner.id);
  assert.equal(token, 'ya29.real-access');
  // The real token drives the LIVE Drive client → real files (not the fake drive).
  assert.equal(liveClientFor('google-drive', token).mode, 'live');
});

test('governance: only the owner can store tokens or sync', async () => {
  const conn = await makeDrive();
  await assert.rejects(
    storeConnectionTokens(conn.id, 'intruder', { accessToken: 'x', expiresAt: nowSec() + 3600 }),
    /owner/i,
  );
  await storeConnectionTokens(conn.id, owner.id, { accessToken: 'ya29.real', refreshToken: 'r', expiresAt: nowSec() + 3600 });
  await assert.rejects(resolveConnectionAccessToken(conn.id, 'intruder'), /owner/i);
});

test('an expired token with an unreachable refresh endpoint degrades to the mock (needs-reconnect)', async () => {
  const conn = await makeDrive();
  // Stored token already expired; refresh will hit the offline-stub fetch and fail.
  await storeConnectionTokens(conn.id, owner.id, { accessToken: 'stale', refreshToken: 'r', expiresAt: nowSec() - 10 });
  const token = await resolveConnectionAccessToken(conn.id, owner.id);
  assert.equal(token, null);
  assert.equal(liveClientFor('google-drive', token).mode, 'mock');
});

test('restore real fetch', () => {
  globalThis.fetch = _realFetch;
});

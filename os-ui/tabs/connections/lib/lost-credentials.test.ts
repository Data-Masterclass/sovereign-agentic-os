/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connections whose credential was lost before the store was durable read needs-reconnect
 * USER STORY: As an admin I see which connections lost their credential (the old in-memory store forgot
 *             every credential on restart), so I can tell each owner to reconnect — instead of the
 *             connection failing obscurely on its next call.
 * ARCHITECTURE: the real Connections store + the real credential store; the "restart" swaps in an empty
 *               credential backend while the connection record survives (as the mirror's copy does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, listLostCredentialConnections, getConnectionForUser, rotateConnectionCredential, __resetConnections } = await import('./store.ts');
const { __configureSecretStoreForTests, ensureSecretsHydrated } = await import('@core/infra/secrets');
const { memorySecretBackend } = await import('@core/infra/secret-backend');
const { healthWarnings } = await import('@core/infra/health-warnings');

const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };

test.after(() => __configureSecretStoreForTests(null));

test('a connection whose credential is gone is listed and marked needs-reconnect; rotate recovers it', async () => {
  __resetConnections();
  __configureSecretStoreForTests(memorySecretBackend());
  await ensureSecretsHydrated();
  const c = await createConnection(admin, { name: 'Gmail', template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'tok' });
  assert.deepEqual(await listLostCredentialConnections(), []);

  // The pre-durable restart: the credential store is empty, the record survived.
  __configureSecretStoreForTests(memorySecretBackend());
  await ensureSecretsHydrated();
  const lost = await listLostCredentialConnections();
  assert.deepEqual(lost.map((x) => x.id), [c.id]);
  assert.equal(lost[0].owner, 'a1');
  assert.equal((await getConnectionForUser(c.id, admin))?.health, 'needs-reconnect');
  assert.ok(healthWarnings().some((w) => /1 connection\(s\) have no stored credential/.test(w)));

  await rotateConnectionCredential(c.id, admin, 'fresh');
  assert.deepEqual(await listLostCredentialConnections(), []);
  assert.ok(!healthWarnings().some((w) => /no stored credential/.test(w)));
});

test('a connection that never had a credential is not "lost"', async () => {
  __resetConnections();
  __configureSecretStoreForTests(memorySecretBackend());
  await ensureSecretsHydrated();
  await createConnection(admin, { name: 'My Drive', template: 'gdrive', endpoint: '', credential: '' });
  assert.deepEqual(await listLostCredentialConnections(), []);
});

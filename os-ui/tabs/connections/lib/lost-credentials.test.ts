/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connections whose credential was lost before the store was durable read needs-reconnect
 * USER STORY: As an admin I see which connections lost their credential (the old in-memory store forgot
 *             every credential on restart), so I can tell each owner to reconnect — instead of the
 *             connection failing obscurely on its next call.
 * ARCHITECTURE: the real Connections store + the real credential store; the "restart" swaps in an empty
 *               credential backend while the connection record survives (as the mirror's copy does).
 *               The lost-master-key case runs the real key manager over a memory key record: a new
 *               master key LOCKS the record (nothing is marked — it can still be unlocked); after an
 *               admin starts over, the old value is undecryptable and the connection reads needs-reconnect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createConnection, listLostCredentialConnections, getConnectionForUser, rotateConnectionCredential, __resetConnections } = await import('./store.ts');
const { __configureSecretStoreForTests, ensureSecretsHydrated } = await import('@core/infra/secrets');
const { memorySecretBackend } = await import('@core/infra/secret-backend');
const { healthWarnings } = await import('@core/infra/health-warnings');
const { memoryKeyStateStore } = await import('@core/infra/key-state');
const { resetLockedKeys, keyManagerStatus } = await import('@core/infra/key-manager');
const { reloadSecretKeys, refreshSecrets, secretStoreStatus } = await import('@core/infra/secrets');

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
  assert.ok(healthWarnings().some((w) => /1 connection\(s\) have no usable stored credential/.test(w)));

  await rotateConnectionCredential(c.id, admin, 'fresh');
  assert.deepEqual(await listLostCredentialConnections(), []);
  assert.ok(!healthWarnings().some((w) => /no usable stored credential/.test(w)));
});

test('a connection that never had a credential is not "lost"', async () => {
  __resetConnections();
  __configureSecretStoreForTests(memorySecretBackend());
  await ensureSecretsHydrated();
  await createConnection(admin, { name: 'My Drive', template: 'gdrive', endpoint: '', credential: '' });
  assert.deepEqual(await listLostCredentialConnections(), []);
});

test('master key LOST, no recovery key: locked marks nothing; after "start over" the connection needs reconnect, and reconnecting works', async () => {
  __resetConnections();
  const KEY1 = { OS_SECRETS_ENCRYPTION_KEY: 'd'.repeat(20) + 'first-master-key-0123456789ab' } as NodeJS.ProcessEnv;
  const KEY2 = { OS_SECRETS_ENCRYPTION_KEY: 'e'.repeat(20) + 'rebuilt-master-key-987654321x' } as NodeJS.ProcessEnv;
  const backend = memorySecretBackend();
  const keyStore = memoryKeyStateStore();
  __configureSecretStoreForTests(backend, KEY1, { keyStore });
  await ensureSecretsHydrated();
  const c = await createConnection(admin, { name: 'Gmail', template: 'gmail', endpoint: 'https://gmail.googleapis.com', credential: 'api-key-1' });
  assert.deepEqual(await listLostCredentialConnections(), []);

  // The cluster's master key is lost (a rebuild generated a new one); the key record and the ciphertext survive.
  __configureSecretStoreForTests(backend, KEY2, { keyStore });
  await ensureSecretsHydrated();
  assert.equal(keyManagerStatus(), 'locked');
  assert.deepEqual(await listLostCredentialConnections(), [], 'while locked nothing is marked — an admin may still unlock');

  // No recovery key: the admin starts over with new keys.
  await resetLockedKeys('a1');
  await reloadSecretKeys();
  assert.equal(secretStoreStatus().status, 'ready');
  assert.equal(secretStoreStatus().unknownKey, 1, 'the old value is sealed under a key nobody holds — never guessed');
  const lost = await listLostCredentialConnections();
  assert.deepEqual(lost.map((x) => x.id), [c.id]);
  assert.equal((await getConnectionForUser(c.id, admin))?.health, 'needs-reconnect');
  assert.ok(healthWarnings().some((w) => /no longer decryptable after the encryption key changed/.test(w)));

  // Reconnect: the owner enters the key again; it overwrites the undecryptable value.
  await rotateConnectionCredential(c.id, admin, 'api-key-2');
  assert.deepEqual(await listLostCredentialConnections(), []);
  await refreshSecrets(); // the next listing sees the re-sealed value
  assert.equal(secretStoreStatus().unknownKey, 0);
  __configureSecretStoreForTests(null);
});

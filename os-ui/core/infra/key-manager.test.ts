/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Envelope encryption with pluggable key providers, recovery key, rotate / switch / restore
 * USER STORY: As an admin I rotate keys, move them to STACKIT KMS, or restore a lost cluster with my
 *             recovery key — and no stored connection credential is ever lost or exposed on the way.
 * ARCHITECTURE:
 *   - The REAL key-manager / key-providers / key-recovery / secrets store against a memory key record,
 *     a memory credential backend, and a MOCK STACKIT KMS (a fetch that implements the encrypt/decrypt
 *     routes with its own AES key, and can be told to refuse). No network, no cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  checkProviderHealth,
  configureKeyManager,
  confirmRecoveryKey,
  connectionKeyAlerts,
  currentKeyring,
  generateRecoveryKey,
  keyManagerStatus,
  keyView,
  loadKeys,
  restoreWithRecoveryKey,
  rotateKeys,
  switchProvider,
  testProviderConfig,
  testRestore,
  updateProviderCredential,
  keyHealthSummary,
  pruneRetiredDataKeys,
  KEYS_HEALTH,
} from '@core/infra/key-manager';
import { createKeyProvider, envKekProvider, stackitKmsProvider, unavailableProvider } from '@core/infra/key-providers';
import { stackitKmsCall, type FetchLike } from '@core/adapters/stackit-kms/client';
import { newRecoveryKey, recoveryKeyMatches, recoveryVerifier, unwrapWithRecovery, wrapForRecovery } from '@core/infra/key-recovery';
import { memoryKeyStateStore } from '@core/infra/key-state';
import { getHealthWarning } from '@core/infra/health-warnings';
import { memorySecretBackend } from '@core/infra/secret-backend';
import { keyringFromEnv, sealSecret, sealedKeyId } from '@core/infra/secret-crypto';
import {
  __configureSecretStoreForTests,
  awaitSecretWrites,
  ensureSecretsHydrated,
  getSecretServerSide,
  putSecret,
  refreshSecrets,
  reloadSecretKeys,
  secretStoreStatus,
  SecretStoreUnavailableError,
} from '@core/infra/secrets';

const KEK1 = 'a'.repeat(20) + 'builtin-master-key-0123456789';
const KEK2 = 'b'.repeat(20) + 'rebuilt-cluster-key-987654321';
const env = (k = KEK1) => ({ OS_SECRETS_ENCRYPTION_KEY: k }) as NodeJS.ProcessEnv;
const STACKIT_CFG = { projectId: 'p1', region: 'eu01', keyRingId: 'kr1', keyId: 'k1', keyVersion: '1' };

/** A mock STACKIT KMS: AES-GCM under its own key; `mode.refuse` answers 403; records calls (no token in them). */
function mockKms() {
  const kmsKey = randomBytes(32);
  const mode = { refuse: false, down: false };
  const calls: string[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (mode.down) throw new Error('ECONNREFUSED');
    if (mode.refuse || init.headers.authorization !== 'Bearer good-token') return { status: 403, json: async () => ({}) };
    const m = url.match(/\/v1\/projects\/p1\/regions\/eu01\/keyrings\/kr1\/keys\/k1\/versions\/(\d+)\/(encrypt|decrypt)$/);
    if (!m) return { status: 404, json: async () => ({}) };
    const data = Buffer.from((JSON.parse(init.body) as { data: string }).data, 'base64');
    if (m[2] === 'encrypt') {
      const n = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kmsKey, n);
      const ct = Buffer.concat([c.update(data), c.final()]);
      return { status: 200, json: async () => ({ data: Buffer.concat([n, c.getAuthTag(), ct]).toString('base64') }) };
    }
    try {
      const d = createDecipheriv('aes-256-gcm', kmsKey, data.subarray(0, 12));
      d.setAuthTag(data.subarray(12, 28));
      return { status: 200, json: async () => ({ data: Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('base64') }) };
    } catch {
      return { status: 400, json: async () => ({}) };
    }
  };
  return { f, mode, calls };
}

// ------------------------------------------------------------------ providers --

test('every available provider round-trips a data key; a wrap binds its key id', async () => {
  const kms = mockKms();
  for (const p of [envKekProvider('builtin', KEK1), envKekProvider('eso', KEK1), stackitKmsProvider(STACKIT_CFG, 'good-token', stackitKmsCall(kms.f))]) {
    const dek = randomBytes(32);
    const w = await p.wrap(dek, 'id-1');
    assert.ok(!w.includes(dek.toString('base64')), `${p.id}: the wrap must not contain the key`);
    assert.deepEqual(await p.unwrap(w, 'id-1'), dek, p.id);
    await assert.rejects(p.unwrap(w, 'id-2'), /another|authentication/, `${p.id}: a wrap moved to another key id is refused`);
    assert.equal((await p.health()).ok, true, p.id);
  }
  assert.ok(kms.calls.every((c) => !c.includes('good-token')), 'the token never appears in a URL');
});

test('builtin: another master key cannot unwrap', async () => {
  const w = await envKekProvider('builtin', KEK1).wrap(randomBytes(32), 'x');
  await assert.rejects(envKekProvider('builtin', KEK2).unwrap(w, 'x'), /authentication failed/);
  await assert.rejects(envKekProvider('builtin', 'short').wrap(randomBytes(32), 'x'), /32 characters/);
});

test('stackit: refusals and outages are named; missing config is misconfigured', async () => {
  const kms = mockKms();
  const p = stackitKmsProvider(STACKIT_CFG, 'good-token', stackitKmsCall(kms.f));
  const w = await p.wrap(randomBytes(32), 'x');
  kms.mode.refuse = true;
  await assert.rejects(p.unwrap(w, 'x'), (e: Error & { code?: string }) => e.code === 'denied');
  assert.equal((await p.health()).state, 'denied');
  kms.mode.refuse = false;
  kms.mode.down = true;
  assert.equal((await p.health()).state, 'unreachable');
  assert.equal((await stackitKmsProvider({ projectId: 'p1' }, 'good-token', stackitKmsCall(kms.f)).health()).state, 'misconfigured');
  assert.equal((await stackitKmsProvider(STACKIT_CFG, undefined, stackitKmsCall(kms.f)).health()).state, 'misconfigured');
});

test('AWS / Azure / Google are interface-ready stubs that say "not yet available"', async () => {
  for (const id of ['aws-kms', 'azure-key-vault', 'gcp-kms'] as const) {
    const p = unavailableProvider(id);
    await assert.rejects(p.wrap(randomBytes(32), 'x'), /not yet available/);
    await assert.rejects(p.unwrap('x', 'x'), /not yet available/);
    assert.equal((await p.health()).state, 'not-available');
    assert.equal(createKeyProvider(id, {}, undefined, { env: env(), kms: stackitKmsCall(mockKms().f) }).id, id);
  }
  assert.throws(() => createKeyProvider('hashicorp-vault', {}, undefined, { env: env(), kms: stackitKmsCall(mockKms().f) }), /unknown key provider/);
});

// -------------------------------------------------------------------- recovery --

test('recovery key: only a verifier is stored; wraps need only the public key; the key opens them', () => {
  const rk = newRecoveryKey();
  assert.match(rk, /^([A-Z2-9]{5}-){7}[A-Z2-9]{5}$/);
  const v = recoveryVerifier(rk);
  assert.ok(!JSON.stringify(v).includes(rk.replace(/-/g, '')), 'the verifier does not contain the key');
  assert.equal(recoveryKeyMatches(v, rk.toLowerCase().replace(/-/g, ' ')), true, 'case, spaces and dashes do not matter');
  assert.equal(recoveryKeyMatches(v, newRecoveryKey()), false);
  const dek = randomBytes(32);
  const w = wrapForRecovery(v, dek, 'k1');
  assert.deepEqual(unwrapWithRecovery(v, rk, w, 'k1'), dek);
  assert.throws(() => unwrapWithRecovery(v, newRecoveryKey(), w, 'k1'), /does not match/);
  assert.throws(() => unwrapWithRecovery(v, rk, w, 'k2'), /authentication failed/);
});

// ----------------------------------------------------------------- the manager --

async function fresh(opts: { k?: string; store?: ReturnType<typeof memoryKeyStateStore>; fetch?: FetchLike } = {}) {
  const store = opts.store ?? memoryKeyStateStore();
  configureKeyManager({ store, env: env(opts.k), fetch: opts.fetch ?? mockKms().f });
  await loadKeys();
  return store;
}

test('first boot creates ONE data key (two pods race on a conditional create); the record holds no clear key', async () => {
  const store = memoryKeyStateStore();
  configureKeyManager({ store, env: env() });
  await loadKeys();
  const first = currentKeyring()!.current.id;
  configureKeyManager({ store, env: env() }); // the "other pod"
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, first, 'the second pod adopts the first data key');
  const rec = store.peek()!;
  assert.equal(rec.dataKeys.length, 1);
  assert.equal(rec.provider.id, 'builtin');
  assert.ok(!JSON.stringify(rec).includes(KEK1));
});

test('recovery key: missing → warning; generate → unconfirmed; confirm → warning cleared', async () => {
  await fresh();
  assert.equal(keyView().recovery.state, 'missing');
  assert.match(getHealthWarning(KEYS_HEALTH) ?? '', /no recovery key/);
  assert.equal(connectionKeyAlerts()[0]?.id, 'connection-keys-recovery');
  const { recoveryKey } = await generateRecoveryKey('alice');
  assert.equal(keyView().recovery.state, 'unconfirmed');
  assert.match(getHealthWarning(KEYS_HEALTH) ?? '', /nobody confirmed/);
  assert.ok(!JSON.stringify(keyView()).includes(recoveryKey), 'the view never carries the recovery key');
  await confirmRecoveryKey('alice', recoveryKey);
  assert.equal(keyView().recovery.state, 'confirmed');
  assert.equal(getHealthWarning(KEYS_HEALTH), null);
  assert.deepEqual(connectionKeyAlerts(), []);
  assert.deepEqual(keyView().history.map((h) => h.action).slice(0, 3), ['recovery.confirm', 'recovery.generate', 'init']);
});

test('RESTORE: a rebuilt cluster (new builtin master key) is LOCKED; the recovery key unlocks it to the SAME data key', async () => {
  const store = await fresh();
  const id = currentKeyring()!.current.id;
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  // Velero restore: the key record comes back, the builtin master key Secret does not (new one generated).
  configureKeyManager({ store, env: env(KEK2) });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  assert.equal(currentKeyring(), null);
  assert.match(getHealthWarning(KEYS_HEALTH) ?? '', /LOCKED/);
  assert.equal(connectionKeyAlerts()[0].severity, 'critical');
  await assert.rejects(restoreWithRecoveryKey(newRecoveryKey(), 'alice'), /does not match/);
  assert.equal(keyManagerStatus(), 'locked', 'a wrong key changes nothing');
  const t = await testRestore(recoveryKey);
  assert.equal(t.recovery, 'ok');
  assert.equal(t.provider, 'failed', 'test restore reports that the provider cannot unwrap yet');
  await restoreWithRecoveryKey(recoveryKey, 'alice');
  assert.equal(keyManagerStatus(), 'ready');
  assert.equal(currentKeyring()!.current.id, id);
  // Re-wrapped under the NEW master key: the next boot opens it without the recovery key.
  configureKeyManager({ store, env: env(KEK2) });
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, id);
});

test('test restore writes nothing', async () => {
  const store = await fresh();
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  const before = JSON.stringify(store.peek());
  assert.deepEqual(await testRestore(recoveryKey), { recovery: 'ok', provider: 'ok', detail: '' });
  assert.equal((await testRestore(newRecoveryKey())).recovery, 'wrong-key');
  assert.equal((await testRestore()).recovery, 'skipped');
  assert.equal(JSON.stringify(store.peek()), before);
});

test('ROTATE: a new data key becomes current, the old one stays decrypt-only and recoverable', async () => {
  await fresh();
  const old = currentKeyring()!.current.id;
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  const { currentKeyId } = await rotateKeys({ newDataKey: true }, 'alice');
  assert.notEqual(currentKeyId, old);
  const ring = currentKeyring()!;
  assert.equal(ring.current.id, currentKeyId);
  assert.ok(ring.previous.some((k) => k.id === old));
  assert.ok(keyView().dataKeys.every((k) => k.recoverable), 'the new key is wrapped to the recovery public key without asking for it');
  assert.equal((await testRestore(recoveryKey)).recovery, 'ok');
  await rotateKeys({ newDataKey: false }, 'alice');
  assert.equal(currentKeyring()!.current.id, currentKeyId, 'a re-wrap keeps the data key');
});

test('SWITCH builtin → STACKIT KMS: verified before commit; the builtin key no longer opens the record', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  const id = currentKeyring()!.current.id;
  await assert.rejects(switchProvider('stackit', STACKIT_CFG, 'bad-token', 'alice'), /not usable/);
  assert.equal(store.peek()!.provider.id, 'builtin', 'an unhealthy provider changes nothing');
  await assert.rejects(switchProvider('aws-kms', { keyArn: 'a', region: 'r' }, undefined, 'alice'), /not yet available/);
  await assert.rejects(switchProvider('stackit', { ...STACKIT_CFG, keyId: '' }, 'good-token', 'alice'), /Key ID is required/);
  assert.equal((await testProviderConfig('stackit', STACKIT_CFG, 'good-token')).ok, true);
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  const rec = store.peek()!;
  assert.equal(rec.provider.id, 'stackit');
  assert.ok(rec.provider.credential && !rec.provider.credential.includes('good-token'), 'the token is sealed (under the builtin key)');
  assert.ok(rec.dataKeys.every((k) => k.provider === 'stackit' && k.wrapped.startsWith('stackit.1.')));
  configureKeyManager({ store, env: env(), fetch: kms.f });
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, id, 'a reboot opens the data key through KMS');
  // KMS refuses (token revoked): locked, then a new credential unlocks — verified by unwrapping.
  kms.mode.refuse = true;
  configureKeyManager({ store, env: env(), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  kms.mode.refuse = false;
  await assert.rejects(updateProviderCredential('bad-token', 'alice'), /does not open/);
  await updateProviderCredential('good-token', 'alice');
  assert.equal(keyManagerStatus(), 'ready');
  assert.equal((await checkProviderHealth()).ok, true);
});

test('a failed verification or a concurrent change rolls back: the stored record is untouched', async () => {
  const store = await fresh();
  const before = JSON.stringify(store.peek());
  // Another admin/pod writes meanwhile: our write is conditional and refused.
  await store.write({ ...store.peek()!, updatedAt: 'x' }, '1');
  await assert.rejects(rotateKeys({ newDataKey: true }, 'alice'), /changed meanwhile/);
  assert.notEqual(JSON.stringify(store.peek()), before);
  assert.equal(store.peek()!.updatedAt, 'x', 'the other writer wins; nothing of ours was written');
});

test('MASTER-KEY rotation (builtin/eso): the retired key in OS_SECRETS_ENCRYPTION_KEY_PREVIOUS unwraps, then everything is re-wrapped under the new one', async () => {
  const store = await fresh();
  const id = currentKeyring()!.current.id;
  configureKeyManager({ store, env: { OS_SECRETS_ENCRYPTION_KEY: KEK2, OS_SECRETS_ENCRYPTION_KEY_PREVIOUS: KEK1 } as NodeJS.ProcessEnv });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'ready');
  assert.equal(store.peek()!.history.at(-1)!.action, 'rotate.master-key');
  configureKeyManager({ store, env: env(KEK2) }); // the retired key removed
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, id, 'the new master key alone opens the data key');
});

// ------------------------------------------------------------ review hardening --

test('a MISSING key record over credentials sealed under data keys is a hard failure — never a new key', async () => {
  const store = memoryKeyStateStore();
  configureKeyManager({ store, env: env(), sealedKeyIds: async () => ['deadbeefdeadbeef'] });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'failed');
  assert.match(keyView().reason, /restore os-conn-keyring/);
  assert.equal(store.peek(), null, 'nothing was created');
  // Only legacy (pre-envelope, env-sealed) values: creating the first record is right.
  const legacy = keyringFromEnv(env());
  configureKeyManager({ store, env: env(), legacy: [legacy.current], sealedKeyIds: async () => [legacy.current.id] });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'ready');
});

test('a TAMPERED record (swapped recovery public key / data-key ids) fails its integrity check → locked', async () => {
  const store = await fresh();
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  const evil = recoveryVerifier(newRecoveryKey());
  const rec = store.peek()!;
  await store.write({ ...rec, recovery: { ...rec.recovery!, publicKey: evil.publicKey, salt: evil.salt } }, '3');
  configureKeyManager({ store, env: env() });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  assert.match(keyView().reason, /integrity/);
  await assert.rejects(rotateKeys({ newDataKey: true }, 'mallory'), /locked/, 'no rotation can wrap a new key to the swapped public key');
});

test('a KMS outage is UNAVAILABLE (retried), not LOCKED; a pod that already loaded keeps its keys', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  kms.mode.down = true;
  configureKeyManager({ store, env: env(), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'unavailable');
  assert.equal(connectionKeyAlerts()[0].id, 'connection-keys-unavailable');
  kms.mode.down = false;
  await loadKeys();
  assert.equal(keyManagerStatus(), 'ready', 'it heals on the next pass');
});

test('the STACKIT token only goes to *.stackit.cloud, and a changed config needs the token again', async () => {
  const kms = mockKms();
  assert.equal((await stackitKmsProvider({ ...STACKIT_CFG, endpoint: 'https://evil.example.com' }, 'good-token', stackitKmsCall(kms.f)).health()).state, 'misconfigured');
  assert.equal((await stackitKmsProvider({ ...STACKIT_CFG, endpoint: 'https://kms.api.stackit.cloud.evil.com' }, 'good-token', stackitKmsCall(kms.f)).health()).state, 'misconfigured');
  assert.ok(!kms.calls.length, 'nothing was sent');
  await fresh({ fetch: kms.f });
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  await assert.rejects(switchProvider('stackit', { ...STACKIT_CFG, keyVersion: '2' }, undefined, 'alice'), /required when the configuration changes/);
});

test('a pending recovery key does not invalidate the saved one until it is confirmed', async () => {
  await fresh();
  const { recoveryKey: first } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', first);
  const { recoveryKey: second } = await generateRecoveryKey('alice'); // dialog then closed without saving
  assert.equal(keyView().recovery.state, 'confirmed');
  assert.equal(keyView().recovery.pending, true);
  assert.equal((await testRestore(first)).recovery, 'ok', 'the saved key still works');
  assert.equal((await testRestore(second)).recovery, 'wrong-key', 'the unconfirmed one does not yet');
  await confirmRecoveryKey('alice', second);
  assert.equal((await testRestore(second)).recovery, 'ok');
  assert.equal((await testRestore(first)).recovery, 'wrong-key');
});

test('master-key rotation keeps a STACKIT install unlocked (the sealed token is re-sealed under the new key)', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  configureKeyManager({ store, env: { OS_SECRETS_ENCRYPTION_KEY: KEK2, OS_SECRETS_ENCRYPTION_KEY_PREVIOUS: KEK1 } as NodeJS.ProcessEnv, fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'ready');
  configureKeyManager({ store, env: env(KEK2), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'ready', 'the new builtin key alone opens the token and the signature');
});

test('confirm is BOUND to the key the admin saw: two tabs, the wrong key is refused', async () => {
  await fresh();
  const { recoveryKey: tabA } = await generateRecoveryKey('alice');
  const { recoveryKey: tabB } = await generateRecoveryKey('alice'); // a second tab generated again
  await assert.rejects(confirmRecoveryKey('alice', tabA), /not the recovery key waiting for confirmation/);
  await assert.rejects(confirmRecoveryKey('alice', ''), /not the recovery key/);
  assert.equal(keyView().recovery.state, 'unconfirmed');
  await confirmRecoveryKey('alice', tabB.toLowerCase());
  assert.equal(keyView().recovery.state, 'confirmed');
  assert.equal((await testRestore(tabB)).recovery, 'ok');
});

test('STACKIT KMS key LOST: the recovery key unlocks — data keys move to builtin, verified', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  const id = currentKeyring()!.current.id;
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  kms.mode.refuse = true; // the KMS key was deleted / access revoked for good
  configureKeyManager({ store, env: env(), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  const r = await restoreWithRecoveryKey(recoveryKey, 'alice');
  assert.deepEqual(r, { provider: 'builtin', fellBackFrom: 'stackit' });
  assert.equal(keyManagerStatus(), 'ready');
  assert.equal(currentKeyring()!.current.id, id);
  assert.match(keyView().history[0].detail, /stackit could not be used — moved to builtin/);
  configureKeyManager({ store, env: env(), fetch: kms.f }); // KMS still refuses: the next boot needs no KMS
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, id);
});

test('STACKIT + cluster REBUILT (new builtin key, token unopenable): recovery key unlocks to builtin, or to an admin-picked provider', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  const id = currentKeyring()!.current.id;
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  const snapshot = store.peek()!;
  // (a) default: the stored token cannot be opened under the new builtin key → fall back to builtin.
  configureKeyManager({ store, env: env(KEK2), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  assert.equal((await restoreWithRecoveryKey(recoveryKey, 'alice')).provider, 'builtin');
  assert.equal(currentKeyring()!.current.id, id);
  // (b) the admin picks STACKIT again with a fresh token: switching provider FROM locked.
  const store2 = memoryKeyStateStore();
  await store2.write(snapshot, null);
  configureKeyManager({ store: store2, env: env(KEK2), fetch: kms.f });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  await assert.rejects(restoreWithRecoveryKey(recoveryKey, 'alice', { provider: 'stackit', config: STACKIT_CFG, credential: 'bad-token' }), (e: Error & { status?: number }) => e.status === 400 && /not usable/.test(e.message));
  assert.equal(keyManagerStatus(), 'locked', 'a failed pick changes nothing');
  assert.deepEqual(await restoreWithRecoveryKey(recoveryKey, 'alice', { provider: 'stackit', config: STACKIT_CFG, credential: 'good-token' }), { provider: 'stackit' });
  assert.equal(store2.peek()!.provider.id, 'stackit');
  configureKeyManager({ store: store2, env: env(KEK2), fetch: kms.f });
  await loadKeys();
  assert.equal(currentKeyring()!.current.id, id);
});

test('provider errors leave as named KeyOperationErrors (no raw 500)', async () => {
  const kms = mockKms();
  await fresh({ fetch: kms.f });
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  kms.mode.down = true;
  await assert.rejects(rotateKeys({ newDataKey: true }, 'alice'), (e: Error & { status?: number }) => e.name === 'KeyOperationError' && e.status === 502);
});

test('the signed record covers "recovery confirmed": flipping confirmedAt in the Secret locks', async () => {
  const store = await fresh();
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  const rec = store.peek()!;
  await store.write({ ...rec, recovery: { ...rec.recovery!, confirmedAt: undefined } }, '3');
  configureKeyManager({ store, env: env() });
  await loadKeys();
  assert.equal(keyManagerStatus(), 'locked');
  assert.deepEqual(keyHealthSummary(), { status: 'locked', provider: null, recovery: 'missing' });
});

test('/api/health summary comes from the verified record', async () => {
  await fresh();
  assert.deepEqual(keyHealthSummary(), { status: 'ready', provider: 'builtin', recovery: 'missing' });
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  assert.deepEqual(keyHealthSummary(), { status: 'ready', provider: 'builtin', recovery: 'confirmed' });
});

test('retired data keys are pruned only after the grace period and when nothing uses them (never the current one)', async () => {
  await fresh();
  const old = currentKeyring()!.current.id;
  const { currentKeyId } = await rotateKeys({ newDataKey: true }, 'alice');
  const later = Date.now() + 8 * 86_400_000;
  assert.equal(await pruneRetiredDataKeys(new Set(), Date.now()), 0, 'within the 7-day grace → kept even when unused');
  assert.equal(await pruneRetiredDataKeys(new Set([old, currentKeyId]), later), 0, 'still in use → kept');
  assert.equal(await pruneRetiredDataKeys(new Set(), later), 1);
  assert.deepEqual(keyView().dataKeys.map((k) => k.id), [currentKeyId]);
});

test('the grace period is configurable (OS_KEY_RETIRED_GRACE_DAYS)', async () => {
  configureKeyManager({ store: memoryKeyStateStore(), env: { ...env(), OS_KEY_RETIRED_GRACE_DAYS: '0' } as NodeJS.ProcessEnv });
  await loadKeys();
  await rotateKeys({ newDataKey: true }, 'alice');
  assert.equal(await pruneRetiredDataKeys(new Set(), Date.now() + 1), 1);
});

test('a TRANSIENT KMS outage during restore refuses (no downgrade to builtin)', async () => {
  const kms = mockKms();
  const store = await fresh({ fetch: kms.f });
  const { recoveryKey } = await generateRecoveryKey('alice');
  await confirmRecoveryKey('alice', recoveryKey);
  await switchProvider('stackit', STACKIT_CFG, 'good-token', 'alice');
  const before = JSON.stringify(store.peek());
  kms.mode.down = true; // ECONNREFUSED
  await assert.rejects(restoreWithRecoveryKey(recoveryKey, 'alice'), (e: Error & { status?: number }) => e.status === 503 && /unreachable .*— retry, or pick a provider explicitly/.test(e.message));
  assert.equal(JSON.stringify(store.peek()), before, 'nothing changed — still stackit');
  assert.deepEqual(await restoreWithRecoveryKey(recoveryKey, 'alice', { provider: 'builtin' }), { provider: 'builtin' }, 'an explicit pick still works');
});

// ---------------------------------------------------- the credential store, end to end --

test('store: values seal under the data key, re-seal after a rotation, legacy env-sealed values migrate', async () => {
  const backend = memorySecretBackend();
  // A value PR #334 sealed directly under the env key (before envelope encryption).
  const legacyRing = keyringFromEnv(env());
  await backend.write({ name: 'conn-old', key: 'token', sealed: sealSecret(legacyRing, 'conn-old', 'token', 'legacy-value') }, null);
  const keyStore = memoryKeyStateStore();
  __configureSecretStoreForTests(backend, env(), { keyStore });
  await ensureSecretsHydrated();
  assert.equal(getSecretServerSide({ name: 'conn-old', key: 'token' }), 'legacy-value');
  await refreshSecrets();
  await awaitSecretWrites();
  const dek1 = currentKeyring()!.current.id;
  assert.equal(sealedKeyId(backend.store.get('conn-old/token')!.sealed), dek1, 'the legacy value is re-sealed under the data key');
  putSecret('conn-new', 'token', 'new-value');
  await awaitSecretWrites();
  assert.equal(sealedKeyId(backend.store.get('conn-new/token')!.sealed), dek1);
  const { currentKeyId } = await rotateKeys({ newDataKey: true }, 'alice');
  await reloadSecretKeys(); // re-open everything under the new keyring → re-seal
  await awaitSecretWrites();
  await refreshSecrets();
  for (const k of ['conn-old/token', 'conn-new/token']) assert.equal(sealedKeyId(backend.store.get(k)!.sealed), currentKeyId, `${k} re-sealed`);
  assert.equal(secretStoreStatus().sealedUnderPreviousKey, 0);
  assert.ok(![...backend.store.values()].some((r) => r.sealed.includes('value')), 'ciphertext only');
});

test('store: a value sealed under a key NOBODY holds is counted (unknownKey) — never guessed', async () => {
  const backend = memorySecretBackend();
  const stranger = keyringFromEnv(env(KEK2)); // e.g. sealed under a data key from a key record that was lost
  await backend.write({ name: 'conn-x', key: 'token', sealed: sealSecret(stranger, 'conn-x', 'token', 'v') }, null);
  // A key record already exists (so first-boot guard does not apply); the value's key is in neither it nor the env key.
  const keyStore = memoryKeyStateStore();
  configureKeyManager({ store: keyStore, env: env() });
  await loadKeys();
  __configureSecretStoreForTests(backend, env(), { keyStore });
  await ensureSecretsHydrated();
  assert.equal(secretStoreStatus().unknownKey, 1);
  assert.equal(getSecretServerSide({ name: 'conn-x', key: 'token' }), null);
});

test('store: a pod still on the OLD keyring writes under a retired key after the re-seal — still readable (grace)', async () => {
  const backend = memorySecretBackend();
  const keyStore = memoryKeyStateStore();
  __configureSecretStoreForTests(backend, env(), { keyStore });
  await ensureSecretsHydrated();
  putSecret('conn-a', 'token', 'a');
  await awaitSecretWrites();
  const oldRing = currentKeyring()!; // what the worker holds
  await rotateKeys({ newDataKey: true }, 'alice');
  await reloadSecretKeys();
  await awaitSecretWrites();
  await refreshSecrets(); // os-ui re-sealed everything; the prune ran and must have kept the old key (grace)
  await awaitSecretWrites();
  assert.equal(secretStoreStatus().sealedUnderPreviousKey, 0);
  assert.ok(keyView().dataKeys.some((k) => k.id === oldRing.current.id), 'the retired key is still in the record');
  // The worker (old keyring in memory) now writes a refreshed token under the OLD data key.
  const cur = await backend.read({ name: 'conn-a', key: 'token' });
  await backend.write({ name: 'conn-a', key: 'token', sealed: sealSecret(oldRing, 'conn-a', 'token', 'a-refreshed') }, cur!.version);
  await refreshSecrets();
  await awaitSecretWrites();
  assert.equal(getSecretServerSide({ name: 'conn-a', key: 'token' }), 'a-refreshed', 'readable');
  assert.equal(secretStoreStatus().unreadable, 0);
});

test('store: a locked data key refuses writes and says so', async () => {
  const backend = memorySecretBackend();
  const keyStore = memoryKeyStateStore();
  __configureSecretStoreForTests(backend, env(), { keyStore });
  await ensureSecretsHydrated();
  putSecret('c', 'k', 'v');
  await awaitSecretWrites();
  __configureSecretStoreForTests(backend, env(KEK2), { keyStore }); // restored cluster, new master key
  await ensureSecretsHydrated();
  assert.equal(secretStoreStatus().status, 'locked');
  assert.throws(() => putSecret('c', 'k', 'v2'), (e: Error) => e instanceof SecretStoreUnavailableError && /locked/.test(e.message));
  __configureSecretStoreForTests(null);
});

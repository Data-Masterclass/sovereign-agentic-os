/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The connection-credential store survives a restart and is shared by os-ui and the worker
 * USER STORY: As a user I connect a system once; after os-ui restarts the connection still works, and an
 *             agent run in the worker can use the credential I saved in the web app.
 * ARCHITECTURE:
 *   - The REAL `secrets.ts` + `kubernetesSecretBackend` against a fake Kubernetes API that implements
 *     exactly the Secret REST calls the backend makes — list by label with `continue`, GET, POST (409 on
 *     exists), PUT with optimistic concurrency on `metadata.resourceVersion` (409 when it moved), DELETE.
 *   - A "process" is a fresh store state (`__configureSecretStoreForTests`) over the SAME fake API:
 *     restart = a new state; the worker = another state reading the same Secrets. `as(p)` swaps one in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  putSecret,
  getSecretServerSide,
  hasSecret,
  deleteSecret,
  secretFingerprint,
  ensureSecretsHydrated,
  refreshSecrets,
  awaitSecretWrites,
  secretStoreStatus,
  SecretStoreUnavailableError,
  __configureSecretStoreForTests,
} from '@core/infra/secrets';
import { kubernetesSecretBackend, k8sSecretName, SECRET_LABELS, MAX_SECRET_VALUE_BYTES, type K8sCall } from '@core/infra/secret-backend';
import { openSecret, keyringFromEnv, sealSecret, sealedKeyId, SecretCryptoError } from '@core/infra/secret-crypto';
import { healthWarnings } from '@core/infra/health-warnings';

const KEY = 'k'.repeat(16) + 'test-encryption-secret-0123456789';
const KEY2 = 'n'.repeat(16) + 'next-encryption-secret-9876543210';
const ENV = { OS_SECRETS_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv;
const NS = 'agentic-os-conn-secrets';

type Obj = { metadata: { name: string; resourceVersion?: string; labels: Record<string, string>; annotations: Record<string, string> }; data: Record<string, string> };

/** A fake API server holding Secrets in one namespace. `mode.status` makes every call answer that status. */
function fakeApi(opts: { pageSize?: number } = {}) {
  const store = new Map<string, Obj>();
  const mode: { status?: number; failWrites?: boolean } = {};
  let rv = 100;
  const call: K8sCall = async (method, path, body) => {
    if (mode.status !== undefined) return { status: mode.status, body: { message: 'denied' } };
    if (mode.failWrites && method !== 'GET') return { status: 500, body: { message: 'etcd timeout' } };
    const m = path.match(new RegExp(`^/api/v1/namespaces/${NS}/secrets(?:/([^?]+))?(?:\\?(.*))?$`));
    if (!m) return { status: 404, body: {} };
    const [, name, query] = m;
    if (method === 'GET' && !name) {
      const q = new URLSearchParams(query ?? '');
      const sel = (q.get('labelSelector') ?? '').split(',').map((kv) => kv.split('='));
      const all = [...store.values()].filter((o) => sel.every(([k, v]) => o.metadata.labels[k] === v));
      const start = Number(q.get('continue') ?? 0);
      const size = opts.pageSize ?? 500;
      return { status: 200, body: { items: structuredClone(all.slice(start, start + size)), metadata: { continue: start + size < all.length ? String(start + size) : '' } } };
    }
    if (method === 'GET') return store.has(name!) ? { status: 200, body: structuredClone(store.get(name!)) as never } : { status: 404, body: {} };
    if (method === 'PUT') {
      const cur = store.get(name!);
      if (!cur) return { status: 404, body: {} };
      const o = structuredClone(body) as Obj;
      if (o.metadata.resourceVersion && o.metadata.resourceVersion !== cur.metadata.resourceVersion) return { status: 409, body: { message: 'conflict' } };
      o.metadata.resourceVersion = String(++rv);
      store.set(name!, o);
      return { status: 200, body: structuredClone(o) as never };
    }
    if (method === 'POST') {
      const o = structuredClone(body) as Obj;
      if (store.has(o.metadata.name)) return { status: 409, body: {} };
      o.metadata.resourceVersion = String(++rv);
      store.set(o.metadata.name, o);
      return { status: 201, body: structuredClone(o) as never };
    }
    if (method === 'DELETE') return { status: store.delete(name!) ? 200 : 404, body: {} };
    return { status: 405, body: {} };
  };
  return { store, mode, call };
}

const SLOT = Symbol.for('soa.secrets.store');
/** Boot a fresh process over `api`; returns its state slot so a test can switch back to it. */
async function boot(api: ReturnType<typeof fakeApi>, env = ENV): Promise<unknown> {
  __configureSecretStoreForTests(kubernetesSecretBackend({ namespace: NS, k8s: api.call }), env);
  await ensureSecretsHydrated();
  return (globalThis as any)[SLOT];
}
const as = (p: unknown) => ((globalThis as any)[SLOT] = p);

test.after(() => __configureSecretStoreForTests(null));

test('write → restart (a new process) → read: the credential survives', async () => {
  const api = fakeApi();
  await boot(api);
  const ref = putSecret('connection-crm-u1', 'token', 'tok-ABC-123');
  await awaitSecretWrites([ref]);
  const fp = secretFingerprint(ref);
  await boot(api);
  assert.equal(secretStoreStatus().status, 'ready');
  assert.equal(getSecretServerSide(ref), 'tok-ABC-123');
  assert.equal(hasSecret(ref), true);
  assert.equal(secretFingerprint(ref), fp, 'stable across processes (same server key)');
});

test('the worker reads what os-ui wrote, and sees its delete', async () => {
  const api = fakeApi();
  const osUi = await boot(api);
  const ref = putSecret('connection-gh-u2', 'token', 'ghp_worker_sees_this');
  await awaitSecretWrites([ref]);
  const worker = await boot(api);
  assert.equal(getSecretServerSide(ref), 'ghp_worker_sees_this');
  as(osUi);
  deleteSecret(ref);
  await awaitSecretWrites([ref]);
  as(worker);
  await refreshSecrets();
  assert.equal(getSecretServerSide(ref), null);
});

test('backend is the truth: another pod\'s newer value replaces the cached one (by version, not clock)', async () => {
  const api = fakeApi();
  const osUi = await boot(api);
  const ref = putSecret('connection-drive-u3', 'token', 'v1');
  await awaitSecretWrites([ref]);
  await boot(api); // worker
  putSecret(ref.name, ref.key, 'v2');
  await awaitSecretWrites([ref]);
  as(osUi);
  await refreshSecrets();
  assert.equal(getSecretServerSide(ref), 'v2');
});

test('OAuth refresh race: the second refresher ADOPTS the token set the first one stored', async () => {
  const api = fakeApi();
  const a = await boot(api);
  const ref = putSecret('connection-drive-u9', 'token', 'set-0');
  await awaitSecretWrites([ref]);
  const b = await boot(api); // both pods hold set-0 at the same version
  as(a);
  putSecret(ref.name, ref.key, 'set-A', 'adopt');
  await awaitSecretWrites([ref]);
  as(b);
  putSecret(ref.name, ref.key, 'set-B', 'adopt'); // conditional PUT on the stale version → 409 → adopt
  await awaitSecretWrites([ref]);
  assert.equal(getSecretServerSide(ref), 'set-A', 'pod B took the value pod A stored');
  assert.equal(secretStoreStatus().conflictsAdopted, 1);
  const stored = api.store.get(k8sSecretName(ref))!;
  assert.equal(openSecret(keyringFromEnv(ENV), ref.name, ref.key, Buffer.from(stored.data.sealed, 'base64').toString('utf8')), 'set-A', 'B did not clobber A');
});

test('an explicit save (overwrite) wins a conflict by re-reading the current version', async () => {
  const api = fakeApi();
  const a = await boot(api);
  const ref = putSecret('connection-x-u10', 'token', 'old');
  await awaitSecretWrites([ref]);
  const b = await boot(api);
  as(a);
  putSecret(ref.name, ref.key, 'a-new');
  await awaitSecretWrites([ref]);
  as(b);
  putSecret(ref.name, ref.key, 'b-rotated'); // stale version → 409 → re-read → overwrite
  await awaitSecretWrites([ref]);
  await boot(api);
  assert.equal(getSecretServerSide(ref), 'b-rotated');
});

test('no plaintext in the Kubernetes Secret; labels + name are what the chart RBAC expects', async () => {
  const api = fakeApi();
  await boot(api);
  const value = 'super-secret-PLAINTEXT-value-42';
  const ref = putSecret('connection-x-u4', 'api_key', value);
  await awaitSecretWrites([ref]);
  const obj = api.store.get(k8sSecretName(ref))!;
  assert.ok(obj, 'one Secret per ref, named from the ref');
  assert.match(obj.metadata.name, /^os-conn-secret-[a-z0-9-]+$/);
  assert.ok(obj.metadata.name.length <= 63);
  assert.equal(obj.metadata.labels['app.kubernetes.io/managed-by'], 'os-ui');
  assert.equal(obj.metadata.labels['app.kubernetes.io/component'], SECRET_LABELS['app.kubernetes.io/component']);
  assert.equal(obj.metadata.labels['os.connection-id'], 'connection-x-u4');
  const serialized = JSON.stringify(obj);
  const decoded = Object.values(obj.data).map((v) => Buffer.from(v, 'base64').toString('utf8')).join('');
  assert.ok(!serialized.includes(value) && !decoded.includes(value), 'value appears nowhere');
  assert.ok(!serialized.includes(Buffer.from(value).toString('base64')), 'not merely base64 of the value');
  const ring = keyringFromEnv(ENV);
  const sealed = Buffer.from(obj.data.sealed, 'base64').toString('utf8');
  assert.equal(openSecret(ring, ref.name, ref.key, sealed), value);
  assert.throws(() => openSecret(ring, ref.name, 'other-key', sealed), SecretCryptoError, 'a ciphertext moved to another ref fails');
});

test('encryption round-trip; tampered ciphertext and a wrong key are rejected; previous keys still decrypt', () => {
  const ring = keyringFromEnv(ENV);
  const sealed = sealSecret(ring, 'n', 'k', 'hello');
  assert.equal(openSecret(ring, 'n', 'k', sealed), 'hello');
  const env = JSON.parse(sealed);
  const ct = Buffer.from(env.c, 'base64');
  ct[0] ^= 0x01;
  assert.throws(() => openSecret(ring, 'n', 'k', JSON.stringify({ ...env, c: ct.toString('base64') })), (e: SecretCryptoError) => e.code === 'tampered');
  const other = keyringFromEnv({ OS_SECRETS_ENCRYPTION_KEY: KEY2 } as NodeJS.ProcessEnv);
  assert.throws(() => openSecret(other, 'n', 'k', sealed), (e: SecretCryptoError) => e.code === 'unknown-key');
  const rotated = keyringFromEnv({ OS_SECRETS_ENCRYPTION_KEY: KEY2, OS_SECRETS_ENCRYPTION_KEY_PREVIOUS: KEY } as NodeJS.ProcessEnv);
  assert.equal(openSecret(rotated, 'n', 'k', sealed), 'hello');
});

test('rotation: a value sealed under the previous key is re-sealed under the current key on refresh', async () => {
  const api = fakeApi();
  await boot(api);
  const ref = putSecret('connection-r-u11', 'token', 'keep-me');
  await awaitSecretWrites([ref]);
  const rotatedEnv = { OS_SECRETS_ENCRYPTION_KEY: KEY2, OS_SECRETS_ENCRYPTION_KEY_PREVIOUS: KEY } as NodeJS.ProcessEnv;
  // While the re-seal cannot be written, the count under the previous key is reported.
  api.mode.failWrites = true;
  await boot(api, rotatedEnv);
  await awaitSecretWrites().catch(() => undefined);
  assert.equal(getSecretServerSide(ref), 'keep-me');
  assert.equal(secretStoreStatus().sealedUnderPreviousKey, 1, 'reported while still under the old key');
  api.mode.failWrites = false;
  await boot(api, rotatedEnv);
  await awaitSecretWrites();
  const kid = sealedKeyId(Buffer.from(api.store.get(k8sSecretName(ref))!.data.sealed, 'base64').toString('utf8'));
  assert.equal(kid, keyringFromEnv(rotatedEnv).current.id, 'now sealed under the current key');
  assert.equal(secretStoreStatus().sealedUnderPreviousKey, 0);
  // ...and a pod holding ONLY the new key can read it.
  await boot(api, { OS_SECRETS_ENCRYPTION_KEY: KEY2 } as NodeJS.ProcessEnv);
  assert.equal(getSecretServerSide(ref), 'keep-me');
});

test('a tampered Secret in the cluster is not served and is reported (count only)', async () => {
  const api = fakeApi();
  await boot(api);
  const ref = putSecret('connection-t-u5', 'token', 'original');
  await awaitSecretWrites([ref]);
  const obj = api.store.get(k8sSecretName(ref))!;
  const env = JSON.parse(Buffer.from(obj.data.sealed, 'base64').toString('utf8'));
  const ct = Buffer.from(env.c, 'base64');
  ct[ct.length - 1] ^= 0xff;
  obj.data.sealed = Buffer.from(JSON.stringify({ ...env, c: ct.toString('base64') })).toString('base64');
  await boot(api);
  assert.equal(getSecretServerSide(ref), null, 'never served');
  assert.equal(secretStoreStatus().unreadable, 1);
  const w = healthWarnings().find((x) => /cannot be decrypted/.test(x)) ?? '';
  assert.ok(w, 'health warning raised');
  assert.ok(!w.includes('connection-t-u5'), 'health text carries no ref names (any signed-in user reads it)');
});

test('fingerprint is a keyed HMAC, not an unsalted sha256 of the value', async () => {
  await boot(fakeApi());
  const ref = putSecret('connection-f', 'token', 'password1');
  const fp = secretFingerprint(ref);
  assert.match(fp, /^hmac-sha256:[0-9a-f]{16}$/);
  const { createHash } = await import('crypto');
  assert.ok(!fp.includes(createHash('sha256').update('password1').digest('hex').slice(0, 12)));
});

test('missing Kubernetes access fails LOUDLY: health warning, writes throw — no memory fallback', async () => {
  const api = fakeApi();
  api.mode.status = 403;
  await boot(api);
  const s = secretStoreStatus();
  assert.equal(s.status, 'unavailable');
  assert.equal(s.backend, 'kubernetes', 'still the cluster backend — never swapped for memory');
  assert.match(s.reason, /not allowed to list Secrets/);
  assert.ok(healthWarnings().some((w) => /credential store is not answering/.test(w)));
  assert.throws(() => putSecret('connection-y', 'token', 'v'), SecretStoreUnavailableError);
  assert.equal(getSecretServerSide({ name: 'connection-y', key: 'token' }), null);
});

test('API down at boot, then restored → the store recovers on its own (no restart)', async () => {
  const api = fakeApi();
  await boot(api);
  const ref = putSecret('connection-boot-u12', 'token', 'survives-the-blip');
  await awaitSecretWrites([ref]);
  api.mode.status = 0; // the API server is unreachable while this pod boots
  await boot(api);
  assert.equal(secretStoreStatus().status, 'unavailable');
  assert.match(secretStoreStatus().reason, /unreachable/);
  await refreshSecrets({ respectBackoff: true });
  assert.equal(secretStoreStatus().status, 'unavailable', 'backoff: not retried before it is due');
  api.mode.status = undefined; // the API answers again
  await refreshSecrets(); // what the timer does once the backoff is due
  assert.equal(secretStoreStatus().status, 'ready');
  assert.equal(getSecretServerSide(ref), 'survives-the-blip');
  assert.ok(!healthWarnings().some((w) => /Connection secrets/.test(w)), 'warning cleared');
});

test('configuration errors are permanent: no key, unknown backend, no namespace', async () => {
  await boot(fakeApi(), {} as NodeJS.ProcessEnv);
  assert.equal(secretStoreStatus().status, 'failed');
  assert.match(secretStoreStatus().reason, /OS_SECRETS_ENCRYPTION_KEY is not set/);
  await refreshSecrets();
  assert.equal(secretStoreStatus().status, 'failed', 'a refresh cannot fix a missing key');
  assert.throws(() => putSecret('a', 'b', 'c'), SecretStoreUnavailableError);

  const saved = { ...process.env };
  try {
    __configureSecretStoreForTests(null);
    process.env.OS_SECRETS_BACKEND = 'kubernetes';
    process.env.OS_SECRETS_ENCRYPTION_KEY = KEY;
    delete process.env.OS_SECRETS_NAMESPACE;
    assert.equal(secretStoreStatus().status, 'failed');
    assert.match(secretStoreStatus().reason, /OS_SECRETS_NAMESPACE is not set/);
    __configureSecretStoreForTests(null);
    process.env.OS_SECRETS_BACKEND = 'vault';
    assert.match(secretStoreStatus().reason, /not a known backend/);
  } finally {
    process.env = saved;
    __configureSecretStoreForTests(null);
  }
});

test('a failed durable write stays cached, survives refreshes, is retried, and lands', async () => {
  const api = fakeApi();
  await boot(api);
  api.mode.failWrites = true;
  const ref = putSecret('connection-z', 'token', 'must-not-vanish');
  await assert.rejects(awaitSecretWrites([ref]), SecretStoreUnavailableError);
  assert.ok(healthWarnings().some((w) => /have not reached the store yet/.test(w)));
  await refreshSecrets(); // the listing does not contain it — it must NOT be dropped
  await awaitSecretWrites().catch(() => undefined);
  assert.equal(getSecretServerSide(ref), 'must-not-vanish');
  assert.equal(secretStoreStatus().failedWrites, 1);
  api.mode.failWrites = false;
  await refreshSecrets(); // retries it
  await awaitSecretWrites([ref]);
  assert.equal(secretStoreStatus().failedWrites, 0);
  await boot(api);
  assert.equal(getSecretServerSide(ref), 'must-not-vanish', 'durable now');
});

test('delete goes to the backend by name even when this process never cached the ref', async () => {
  const api = fakeApi();
  await boot(api);
  const ref = putSecret('connection-orphan', 'token', 'x');
  await awaitSecretWrites([ref]);
  api.mode.status = 0;
  await boot(api); // this pod could not load it
  api.mode.status = undefined;
  await refreshSecrets();
  __configureSecretStoreForTests(kubernetesSecretBackend({ namespace: NS, k8s: api.call }), ENV);
  await ensureSecretsHydrated();
  (globalThis as any)[SLOT].cache.clear(); // simulate "not cached here"
  deleteSecret(ref);
  await awaitSecretWrites([ref]);
  assert.equal(api.store.has(k8sSecretName(ref)), false);
});

test('an oversized value is refused up front with a clear error', async () => {
  await boot(fakeApi());
  assert.throws(() => putSecret('connection-big', 'token', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1)), /too large to store/);
});

test('listing follows pagination', async () => {
  const api = fakeApi({ pageSize: 2 });
  await boot(api);
  for (let i = 0; i < 5; i++) putSecret(`connection-p${i}`, 'token', `v${i}`);
  await awaitSecretWrites();
  await boot(api);
  for (let i = 0; i < 5; i++) assert.equal(getSecretServerSide({ name: `connection-p${i}`, key: 'token' }), `v${i}`);
});

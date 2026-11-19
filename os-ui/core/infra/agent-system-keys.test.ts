/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for an agent system's model key: the value, the encryption, the store.
 *
 * USER STORY: As a security reviewer I need proof that a key cannot be derived from a system id,
 *             that a stored key is ciphertext which fails closed when it is tampered with or
 *             read under another secret, that a second process (or the same one after a
 *             restart) reads the key back, and that a system with no key gets an explicit error
 *             instead of someone else's credential.
 *
 * ARCHITECTURE:
 *   No Postgres in this suite, so the store is exercised two ways, like `jobs-postgres.test.ts`:
 *   the in-memory store for behaviour, and the Postgres store over a small fake `SqlClient`
 *   that keeps rows in a map shared between "processes" — each process being a fresh store
 *   object and a dropped read cache. The SQL itself is pinned by statement tripwires.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SYSTEM_KEYS_DDL,
  SystemKeyUnavailableError,
  __setSystemKeyStoreForTests,
  deploymentKek,
  deriveKek,
  isLegacyDerivedToken,
  legacyDerivedKey,
  memorySystemKeyStore,
  migrateSystemKeys,
  mintSystemKey,
  openSystemKey,
  postgresSystemKeyStore,
  resolveSystemKey,
  sealSystemKey,
  systemKeyAlias,
  systemKeyRef,
  systemKeyStatus,
  tokenIdOf,
  type SqlClient,
  type SystemKeyCaps,
  type SystemKeyRecord,
} from './agent-system-keys.ts';

const SECRET = 'unit-test-key-encryption-secret-0123456789';
const KEK = deriveKek(SECRET);
const CAPS: SystemKeyCaps = { models: ['sovereign-default'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 };
const seal = (systemId: string, key: string, kek = KEK): SystemKeyRecord =>
  sealSystemKey({ systemId, alias: systemKeyAlias(systemId), key, caps: CAPS, createdAt: 1000, rotatedAt: null }, kek);

/** A fake Postgres: the four statements this store issues, over one shared row map. */
function fakeDb(): SqlClient & { rows: Map<string, Record<string, unknown>>; sql: string[] } {
  const rows = new Map<string, Record<string, unknown>>();
  const sql: string[] = [];
  return {
    rows,
    sql,
    async query(text, values = []) {
      sql.push(text);
      if (/^\s*INSERT INTO agent_system_keys/.test(text)) {
        const [system_id, key_alias, token_id, kek_id, nonce, ciphertext, tag, caps, created, rotated] = values as [string, string, string, string, string, string, string, string, number, number | null];
        // caps comes back as a parsed object from a jsonb column; timestamps as Dates.
        rows.set(system_id, { system_id, key_alias, token_id, kek_id, nonce, ciphertext, tag, caps: JSON.parse(caps), created_at: new Date(created), rotated_at: rotated === null ? null : new Date(rotated) });
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*SELECT[\s\S]*WHERE system_id = \$1/.test(text)) {
        const r = rows.get(String(values[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/^\s*SELECT/.test(text)) return { rows: [...rows.values()], rowCount: rows.size };
      if (/^\s*DELETE/.test(text)) { rows.delete(String(values[0])); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
}

// The config module read its env at import; this suite drives the secret through the store slot
// and `deploymentKek(secret)` rather than through process.env.
const useStore = (store: ReturnType<typeof memorySystemKeyStore> | null) => __setSystemKeyStoreForTests(store);

// ------------------------------------------------------------------ the value --

test('KEY VALUE: 32 CSPRNG bytes behind the sk- prefix, never the derived pattern, never the same twice', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const key = mintSystemKey();
    assert.match(key, /^sk-[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(key.slice(3), 'base64url').length, 32, '32 bytes of entropy');
    seen.add(key);
  }
  assert.equal(seen.size, 200);
  const key = mintSystemKey();
  for (const id of ['sys_ab12cd34', 'x']) {
    assert.notEqual(key, legacyDerivedKey(systemKeyAlias(id)));
    assert.equal(isLegacyDerivedToken(systemKeyAlias(id), tokenIdOf(key)), false);
  }
});

test('LEGACY KEY: the old guessable value is recognised by its HASH — and only under its own alias', () => {
  const alias = systemKeyAlias('sys_ab12cd34');
  assert.equal(legacyDerivedKey(alias), 'sk-os-sys_ab12cd34');
  assert.equal(isLegacyDerivedToken(alias, tokenIdOf('sk-os-sys_ab12cd34')), true);
  assert.equal(isLegacyDerivedToken('os-other', tokenIdOf('sk-os-sys_ab12cd34')), false);
  assert.equal(isLegacyDerivedToken(alias, undefined), false);
  assert.match(tokenIdOf('sk-anything'), /^[0-9a-f]{64}$/, "LiteLLM's token id: SHA-256, hex");
});

// ------------------------------------------------------------------ at rest ----

test('ENCRYPTION: round trip; the record holds ciphertext and a fresh nonce every time', () => {
  const key = mintSystemKey();
  const a = seal('sys1', key);
  const b = seal('sys1', key);
  assert.equal(openSystemKey(a, KEK), key);
  assert.notEqual(a.nonce, b.nonce, 'a random nonce per record');
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(Buffer.from(a.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(a.tag, 'base64').length, 16);
  const stored = JSON.stringify(a);
  assert.ok(!stored.includes(key) && !stored.includes(key.slice(3)), 'the value is not in the stored record');
  assert.equal(a.tokenId, tokenIdOf(key));
});

test('ENCRYPTION fails CLOSED: tampered ciphertext, tag or nonce; a row moved to another system; a swapped token id', () => {
  const key = mintSystemKey();
  const rec = seal('sys1', key);
  const flip = (b64: string) => { const buf = Buffer.from(b64, 'base64'); buf[0] ^= 0x01; return buf.toString('base64'); };
  const bad: SystemKeyRecord[] = [
    { ...rec, ciphertext: flip(rec.ciphertext) },
    { ...rec, tag: flip(rec.tag) },
    { ...rec, nonce: flip(rec.nonce) },
    { ...rec, systemId: 'sys2' },
    { ...rec, alias: 'os-sys2' },
    { ...rec, tokenId: tokenIdOf('sk-something-else') },
  ];
  for (const r of bad) {
    assert.throws(() => openSystemKey(r, KEK), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'unreadable');
  }
});

test('ENCRYPTION fails CLOSED under another secret — "unreadable", never a garbled key', () => {
  const rec = seal('sys1', mintSystemKey());
  const other = deriveKek('a-different-key-encryption-secret-98765');
  assert.notEqual(other.id, KEK.id);
  assert.throws(() => openSystemKey(rec, other), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'unreadable');
  // Even with the id forged to match, the authentication tag refuses.
  assert.throws(() => openSystemKey({ ...rec, kekId: other.id }, other), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'unreadable');
});

test('THE ENCRYPTION SECRET: too short is refused; the same secret always derives the same key', () => {
  assert.throws(() => deriveKek('short'), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'not-configured');
  assert.throws(() => deriveKek(''), SystemKeyUnavailableError);
  assert.deepEqual(deriveKek(SECRET), KEK, 'stable across processes and restarts');
  assert.equal(KEK.key.length, 32);
  assert.ok(!KEK.key.toString('hex').includes(KEK.id), 'the public id is a separate derivation');
});

// ------------------------------------------------------------------ store ------

test('SQL: the DDL is idempotent; a put is an upsert on the system id; the value never appears in a statement', async () => {
  for (const stmt of AGENT_SYSTEM_KEYS_DDL) assert.match(stmt, /CREATE TABLE IF NOT EXISTS agent_system_keys/);
  assert.match(AGENT_SYSTEM_KEYS_DDL[0], /system_id\s+TEXT PRIMARY KEY/, 'one key per system');
  const db = fakeDb();
  await migrateSystemKeys(db);
  const key = mintSystemKey();
  const args: unknown[][] = [];
  const spy: SqlClient = { query: async (t, v) => { args.push(v ?? []); return db.query(t, v); } };
  await postgresSystemKeyStore(spy).put(seal('sys1', key));
  assert.match(db.sql.at(-1) ?? '', /ON CONFLICT \(system_id\) DO UPDATE/);
  assert.ok(!JSON.stringify(args).includes(key), 'only ciphertext is sent to the database');
});

test('TWO PROCESSES: a key stored by the web process is read by a worker that shares only the database and the secret', async () => {
  const db = fakeDb();
  const key = mintSystemKey();
  // Process A (os-ui web, the Build).
  await postgresSystemKeyStore(db).put(seal('sys1', key));
  // Process B (os-ui-worker): its own store object, nothing in memory, same database, same secret.
  const worker = postgresSystemKeyStore(db);
  const record = await worker.get('sys1');
  assert.ok(record);
  assert.equal(openSystemKey(record, deriveKek(SECRET)), key);
  assert.equal(record.createdAt, 1000);
  assert.equal(record.rotatedAt, null);
  assert.deepEqual(record.caps, CAPS);
  assert.deepEqual((await worker.list()).map((r) => r.systemId), ['sys1']);
});

test('RESTART: dropping everything in memory loses nothing — the next read comes from the store', async () => {
  const db = fakeDb();
  const key = mintSystemKey();
  await postgresSystemKeyStore(db).put(seal('sys1', key, deploymentKek(SECRET)));
  useStore(postgresSystemKeyStore(db));
  // `deploymentKek()` reads config; this test's records are sealed under the same derivation.
  const first = await (await import('./agent-system-keys.ts')).systemKeyStore();
  assert.equal(openSystemKey((await first.get('sys1'))!, deploymentKek(SECRET)), key);
  useStore(postgresSystemKeyStore(db)); // "restart": a new store object and an empty read cache
  const again = await (await import('./agent-system-keys.ts')).systemKeyStore();
  assert.equal(openSystemKey((await again.get('sys1'))!, deploymentKek(SECRET)), key);
  useStore(null);
});

// ------------------------------------------------------------------ read -------

test('RESOLVE: the stored key comes back; a rotation is seen on a fresh read; a deleted key is MISSING', async () => {
  const store = memorySystemKeyStore();
  useStore(store);
  const kek = deploymentKek(); // no database + no secret in the test env ⇒ this process's own key
  const k1 = mintSystemKey();
  await store.put(seal('sys1', k1, kek));
  const got = await resolveSystemKey('sys1');
  assert.deepEqual(got, { key: k1, tokenId: tokenIdOf(k1), alias: 'os-sys1' });
  // Rotated under a run in flight: the cached copy is served until the caller asks for a fresh one.
  const k2 = mintSystemKey();
  await store.put(seal('sys1', k2, kek));
  assert.equal((await resolveSystemKey('sys1')).key, k1, 'cached for a short while');
  assert.equal((await resolveSystemKey('sys1', { fresh: true })).key, k2);
  await store.delete('sys1');
  await assert.rejects(resolveSystemKey('sys1', { fresh: true }), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'missing');
  useStore(null);
});

test('MISSING KEY is explicit: a never-built system is told to press Build — no other credential is returned', async () => {
  useStore(memorySystemKeyStore());
  await assert.rejects(resolveSystemKey('never-built'), (e: unknown) => {
    assert.ok(e instanceof SystemKeyUnavailableError);
    assert.equal(e.reason, 'missing');
    assert.equal(e.code, 'system_key_unavailable');
    assert.match(e.message, /no model key of its own/);
    assert.match(e.message, /press Build/);
    assert.match(e.message, /not moved onto the shared\s+key/);
    return true;
  });
  const status = await systemKeyStatus('never-built');
  assert.equal(status.state, 'missing');
  useStore(null);
});

test('UNREADABLE key (sealed under another secret) and an unreachable store are explicit states too', async () => {
  const store = memorySystemKeyStore();
  useStore(store);
  await store.put(seal('sys1', mintSystemKey(), deriveKek('a-different-key-encryption-secret-98765')));
  await assert.rejects(resolveSystemKey('sys1'), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'unreadable' && /Press Rebuild/.test(e.message));
  assert.equal((await systemKeyStatus('sys1')).state, 'unreadable');
  useStore({ ...store, get: async () => { throw new Error('connection refused'); } });
  await assert.rejects(resolveSystemKey('sys1'), (e: unknown) => e instanceof SystemKeyUnavailableError && e.reason === 'store-unavailable');
  assert.equal((await systemKeyStatus('sys1')).state, 'store-unavailable');
  useStore(null);
});

test('NO KEY MATERIAL leaves the module except through resolveSystemKey: status, reference, records and errors are clean', async () => {
  const store = memorySystemKeyStore();
  useStore(store);
  const key = mintSystemKey();
  await store.put(seal('sys1', key, deploymentKek()));
  const leaked = (v: unknown) => JSON.stringify(v).includes(key) || /sk-[A-Za-z0-9_-]{20,}/.test(JSON.stringify(v));
  const status = await systemKeyStatus('sys1');
  assert.equal(status.state, 'ready');
  assert.equal(leaked(status), false);
  assert.equal(leaked(systemKeyRef('sys1')), false);
  assert.deepEqual(systemKeyRef('sys1'), { name: 'agent-system-key', key: 'sys1' }, 'the reference names the system, nothing else');
  assert.equal(leaked(await store.list()), false);
  for (const reason of ['missing', 'unreadable', 'not-configured', 'store-unavailable'] as const) {
    assert.equal(leaked(new SystemKeyUnavailableError(reason).message), false);
  }
  useStore(null);
});

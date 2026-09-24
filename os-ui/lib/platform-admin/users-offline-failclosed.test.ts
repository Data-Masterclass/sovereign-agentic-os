/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression for the 2026-09-10 all-users lockout: os-ui booted before OpenSearch
 * answered, seeded every account from OS_USERS with the ORIGINAL passwords into a
 * frozen in-memory cache, and dropped every account created since.
 *
 * Contract now: production + unreachable mirror → fail CLOSED (503), no seed;
 * dev opt-in may seed offline, but the mirror replaces that seed once reachable.
 */

// Must be set before any import that pulls in lib/config (which reads it once).
process.env.OS_USERS = JSON.stringify([
  { id: 'seed-admin', name: 'Seed Admin', password: 'Seed-Pass-1234', domains: ['ops'], role: 'admin', email: 'seed@example.test' },
]);
process.env.OS_OFFLINE_REHYDRATE_MS = '0';

type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
let activeFetch: Stub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) =>
  activeFetch ? activeFetch(url, init) : realFetch(url as string, init)) as typeof fetch;

const jsonRes = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const down: Stub = async () => { throw new Error('ECONNREFUSED'); };
function upWith(docs: Record<string, unknown>[]): Stub {
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/os-users/_count') return jsonRes({ count: docs.length });
    if (path === '/os-users/_search') return jsonRes({ hits: { hits: docs.map((_source) => ({ _source })) } });
    if (/^\/os-users\/_doc\//.test(path) && (method === 'PUT' || method === 'DELETE')) return jsonRes({ result: 'ok' });
    return jsonRes({}, 404);
  };
}
let v = 0;
async function freshUsers() {
  v += 1;
  const m = await import(`./users.ts?offline-failclosed=${v}`);
  // The directory state lives on globalThis (Symbol.for) and survives fresh imports:
  // forget it so every test starts like a fresh process.
  m.__resetUsers();
  return m;
}
async function realHash(pw: string) {
  const { hashPassword } = await import('../core/password.ts');
  return hashPassword(pw);
}
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
};

test('production + mirror unreachable → fails CLOSED (503) and does NOT seed from OS_USERS', async () => {
  await withEnv({ NODE_ENV: 'production', OS_ALLOW_OFFLINE_USER_SEED: undefined }, async () => {
    activeFetch = down;
    const users = await freshUsers();
    await assert.rejects(
      () => users.authenticate('seed@example.test', 'Seed-Pass-1234'),
      (e: unknown) => (e as { status?: number; name?: string }).status === 503 && (e as { name?: string }).name === 'DirectoryUnavailableError',
    );
    await assert.rejects(() => users.listUsers(), /unavailable/i);
    activeFetch = null;
  });
});

test('mirror recovers after a failed boot → the REAL directory is served, the seed password is not resurrected', async () => {
  await withEnv({ NODE_ENV: 'production', OS_ALLOW_OFFLINE_USER_SEED: undefined }, async () => {
    activeFetch = down;
    const users = await freshUsers();
    await assert.rejects(() => users.listUsers());
    // OpenSearch answers: an initialised store whose password was CHANGED since the seed.
    const real = await realHash('Real-Changed-Pass-9');
    activeFetch = upWith([
      { id: '__meta__', initialized: true },
      { id: 'seed-admin', name: 'Seed Admin', password: real, domains: ['ops'], role: 'admin', email: 'seed@example.test', emailVerified: true },
    ]);
    assert.equal((await users.authenticate('seed@example.test', 'Real-Changed-Pass-9'))?.id, 'seed-admin', 'changed password wins');
    assert.equal(await users.authenticate('seed@example.test', 'Seed-Pass-1234'), null, 'operator seed password must NOT come back');
    activeFetch = null;
  });
});

test('explicit OS_ALLOW_OFFLINE_USER_SEED=false wins even outside production', async () => {
  await withEnv({ NODE_ENV: 'test', OS_ALLOW_OFFLINE_USER_SEED: 'false' }, async () => {
    activeFetch = down;
    const users = await freshUsers();
    await assert.rejects(() => users.authenticate('seed@example.test', 'Seed-Pass-1234'), /unavailable/i);
    activeFetch = null;
  });
});

test('dev opt-in: offline seed serves, but is REPLACED by the mirror once reachable (never frozen)', async () => {
  await withEnv({ NODE_ENV: 'test', OS_ALLOW_OFFLINE_USER_SEED: 'true' }, async () => {
    activeFetch = down;
    const users = await freshUsers();
    assert.equal((await users.authenticate('seed@example.test', 'Seed-Pass-1234'))?.id, 'seed-admin', 'offline seed works in dev');
    const real = await realHash('Real-Changed-Pass-9');
    activeFetch = upWith([
      { id: '__meta__', initialized: true },
      { id: 'seed-admin', name: 'Seed Admin', password: real, domains: ['ops'], role: 'admin', email: 'seed@example.test', emailVerified: true },
    ]);
    assert.equal((await users.authenticate('seed@example.test', 'Real-Changed-Pass-9'))?.id, 'seed-admin', 'mirror replaced the offline seed');
    assert.equal(await users.authenticate('seed@example.test', 'Seed-Pass-1234'), null, 'stale offline seed is gone');
    activeFetch = null;
  });
});

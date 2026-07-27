/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { removeGatewayModel, type GatewayModelRow } from './model-remove.ts';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

type Call = { url: string; method: string; body: unknown; auth: string };

/** Stub fetch: /model/info returns `rows`; /model/delete returns `deleteOk`. */
function stubGateway(rows: GatewayModelRow[] | 'down', deleteOk = true) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization ?? '' });
    if (rows === 'down') throw new Error('ECONNREFUSED');
    if (url.endsWith('/model/info')) return { ok: true, status: 200, json: async () => ({ data: rows }) } as Response;
    if (url.endsWith('/model/delete')) return { ok: deleteOk, status: deleteOk ? 200 : 400, json: async () => ({}) } as Response;
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const OPTS = { url: 'http://litellm:4000', masterKey: 'sk-test-master' };

test('db-registered model: verifies via /model/info then POSTs /model/delete with the row id', async () => {
  const { calls, fetchImpl } = stubGateway([
    { model_name: 'my-cloud-llm', model_info: { id: 'uuid-1', db_model: true } },
    { model_name: 'sovereign-default', model_info: { id: 'uuid-2', db_model: false } },
  ]);
  const res = await removeGatewayModel('my-cloud-llm', { ...OPTS, fetchImpl });
  assert.deepEqual(res, { status: 'removed', ids: ['uuid-1'] });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/model/info'));
  assert.equal(calls[1].method, 'POST');
  assert.ok(calls[1].url.endsWith('/model/delete'));
  // The RIGHT id: the /model/info row's model_info.id, not the alias.
  assert.deepEqual(calls[1].body, { id: 'uuid-1' });
  // Master key used server-side as a Bearer header (never in the body/result).
  assert.ok(calls[1].auth.startsWith('Bearer '));
  assert.ok(!JSON.stringify(res).includes('sk-test-master'));
});

test('config-seeded model (db_model false) is refused as managed — no delete call', async () => {
  const { calls, fetchImpl } = stubGateway([
    { model_name: 'sovereign-default', model_info: { id: 'uuid-2', db_model: false } },
  ]);
  const res = await removeGatewayModel('sovereign-default', { ...OPTS, fetchImpl });
  assert.deepEqual(res, { status: 'managed' });
  assert.equal(calls.length, 1); // only /model/info — never /model/delete
});

test('db_model absent counts as seeded (fail-safe managed)', async () => {
  const { fetchImpl } = stubGateway([{ model_name: 'x', model_info: { id: 'u' } }]);
  assert.deepEqual(await removeGatewayModel('x', { ...OPTS, fetchImpl }), { status: 'managed' });
});

test('mixed alias (one seeded + one db row) stays managed', async () => {
  const { calls, fetchImpl } = stubGateway([
    { model_name: 'x', model_info: { id: 'u1', db_model: true } },
    { model_name: 'x', model_info: { id: 'u2', db_model: false } },
  ]);
  assert.deepEqual(await removeGatewayModel('x', { ...OPTS, fetchImpl }), { status: 'managed' });
  assert.equal(calls.length, 1);
});

test('alias not at the gateway → not-found', async () => {
  const { fetchImpl } = stubGateway([{ model_name: 'other', model_info: { id: 'u', db_model: true } }]);
  assert.deepEqual(await removeGatewayModel('ghost', { ...OPTS, fetchImpl }), { status: 'not-found' });
});

test('gateway down → unreachable (nothing deleted, no guess)', async () => {
  const { fetchImpl } = stubGateway('down');
  assert.deepEqual(await removeGatewayModel('x', { ...OPTS, fetchImpl }), { status: 'unreachable' });
});

test('rejected /model/delete → failed', async () => {
  const { fetchImpl } = stubGateway([{ model_name: 'x', model_info: { id: 'u1', db_model: true } }], false);
  assert.deepEqual(await removeGatewayModel('x', { ...OPTS, fetchImpl }), { status: 'failed' });
});

test('db rows without an addressable id → failed (never a blind delete)', async () => {
  const { calls, fetchImpl } = stubGateway([{ model_name: 'x', model_info: { db_model: true } }]);
  assert.deepEqual(await removeGatewayModel('x', { ...OPTS, fetchImpl }), { status: 'failed' });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- route tripwires --
// Next route handlers can't be imported under node --test (they pull `next`), so
// these follow the lib/security-route-guards.test.ts convention: read the source
// and assert the gates are wired. Behaviour is proven by the unit tests above.

test('DELETE route: admin-gated, reference-checked, seed-guarded server-side', () => {
  const src = read('app/api/platform-admin/models/[id]/route.ts');
  assert.match(src, /export async function DELETE/, 'DELETE handler exists');
  assert.match(src, /adminCtx\(\)/, 'admin gate (401 anon / 403 non-admin)');
  assert.match(src, /removeGatewayModel/, 'gateway delete goes through the verified helper');
  assert.match(src, /'managed'/, 'seeded/static models refused server-side (db_model guard)');
  assert.match(src, /modelReferences/, 'reference sweep runs before removal');
  assert.match(src, /force/, 'referenced removal needs the explicit force confirmation');
  assert.match(src, /removeModel\(/, 'governed catalog record removed via the guarded adapter');
});

test('references route is admin-gated', () => {
  const src = read('app/api/platform-admin/models/[id]/references/route.ts');
  assert.match(src, /adminCtx\(\)/);
  assert.match(src, /modelReferences/);
});

test('live catalog route surfaces the seeded-vs-admin-added flag (db_model)', () => {
  const src = read('app/api/agents/models/route.ts');
  assert.match(src, /db_model/, 'reads LiteLLM db_model');
  assert.match(src, /dbModel/, 'surfaces it to the admin page');
});

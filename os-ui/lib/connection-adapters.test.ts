/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterFor,
  ADAPTER_KINDS,
  runVerified,
  openApiToTools,
  type AdapterCtx,
} from './connection-adapters.ts';
import { templateByKey } from './connection-model.ts';
import { decide } from './capability-compiler.ts';

function ctx(templateKey: string, over: Partial<AdapterCtx> = {}): AdapterCtx {
  const template = templateByKey(templateKey)!;
  return { template, endpoint: template.endpointHint, credentialPresent: true, ...over };
}

test('every launch connector has an adapter implementing all 5 ops', () => {
  for (const kind of ADAPTER_KINDS) {
    const a = adapterFor(kind);
    assert.equal(a.connector, kind);
    for (const op of ['auth', 'test', 'generateTools', 'compilePolicy', 'sync'] as const) {
      assert.equal(typeof a[op], 'function', `${kind}.${op}`);
    }
  }
});

test('drive auth mints an OAuth token offline (mock) and never persists it in the result record', async () => {
  const a = adapterFor('drive');
  const r = await a.auth(ctx('gdrive', { authCode: 'mock-grant' }));
  assert.ok(r.ok);
  assert.equal(r.mode, 'offline-mock');
  assert.ok(r.data?.secretValue && r.data.secretValue.length > 0);
  assert.equal(r.data?.secretKey, 'oauth-token');
});

test('drive auth uses the LIVE client when injected', async () => {
  const a = adapterFor('drive');
  const r = await a.auth(
    ctx('gdrive', {
      authCode: 'grant',
      clients: { oauth: { exchange: async () => ({ token: 'live-token' }), refresh: async () => null } },
    }),
  );
  assert.equal(r.mode, 'live');
  assert.equal(r.data?.secretValue, 'live-token');
});

test('test() reports offline-mock when no probe client, live when reachable', async () => {
  const a = adapterFor('database');
  const off = await a.test(ctx('database'));
  assert.equal(off.mode, 'offline-mock');
  const live = await a.test(ctx('database', { clients: { probe: { reach: async () => ({ ok: true }) } } }));
  assert.equal(live.mode, 'live');
  assert.ok(live.ok);
});

test('test() fails when no credential is present', async () => {
  const a = adapterFor('database');
  const r = await a.test(ctx('database', { credentialPresent: false }));
  assert.equal(r.ok, false);
});

test('MCP generateTools surfaces the server tools live, safe-preset (writes Off)', async () => {
  const a = adapterFor('mcp');
  const r = await a.generateTools(
    ctx('generic-mcp', {
      clients: {
        schema: {
          fetchOpenApi: async () => null,
          listMcpTools: async () => [
            { name: 'search', write: false },
            { name: 'create', write: true },
          ],
        },
      },
    }),
  );
  assert.equal(r.mode, 'live');
  const create = r.data?.find((t) => t.name === 'create');
  assert.equal(create?.mode, 'Off', 'writes start Off (safe preset)');
});

test('API generateTools compiles an OpenAPI spec into governed tools', async () => {
  const tools = openApiToTools({
    paths: {
      '/accounts': { get: { operationId: 'list_accounts' }, post: { operationId: 'create_account' } },
      '/accounts/{id}': { delete: { operationId: 'delete_account' } },
    },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.list_accounts.mode, 'Read');
  assert.equal(byName.create_account.mode, 'Off'); // write opt-in
  assert.equal(byName.delete_account.mode, 'Blocked'); // delete blocked
});

test('compilePolicy delegates to the one compiler so the gate is identical', async () => {
  const a = adapterFor('database');
  const c = ctx('database');
  const bundle = a.compilePolicy('conn-db', c);
  assert.equal(decide(bundle, 'query').effect, 'allow');
  assert.equal(decide(bundle, 'drop_table').effect, 'deny'); // Blocked
});

test('database sync ingests to Bronze; drive sync indexes to Files (apply->verify)', async () => {
  const db = await runVerified('sync', () => adapterFor('database').sync(ctx('database')), (r) => Boolean(r.data && (r.data as { records: number }).records >= 0));
  assert.ok(db.ok && db.applied && db.verified);
  const drv = await adapterFor('drive').sync(ctx('gdrive'));
  assert.equal(drv.data?.target, 'files');
});

test('runVerified marks ✗ when verify fails even though apply succeeded', async () => {
  const row = await runVerified('test', async () => ({ ok: true, mode: 'offline-mock' as const, detail: 'applied' }), () => false);
  assert.equal(row.ok, false);
  assert.equal(row.applied, true);
  assert.equal(row.verified, false);
});

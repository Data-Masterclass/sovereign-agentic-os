/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type PurviewConn,
  purviewHealth,
  purviewSearchAssets,
  purviewGetAsset,
  purviewListClassifications,
  purviewGetLineage,
} from './purview.ts';

function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'eyJfake-purview-token-xxx';
function conn(fetchImpl: typeof fetch): PurviewConn {
  return { baseUrl: 'https://acme.purview.azure.com', token: TOKEN, fetchImpl };
}

test('searchAssets POSTs the query, injects the Bearer, shapes rows', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.includes('/catalog/api/search/query'));
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    return { status: 200, body: { value: [{ guid: 'a1', name: 'orders', entityType: 'azure_sql_table', qualifiedName: 'mssql://x/orders' }] } };
  });
  const r = await purviewSearchAssets(conn(f.impl), 'orders');
  assert.ok(r.ok && r.data[0].guid === 'a1' && r.data[0].typeName === 'azure_sql_table');
});

test('searchAssets needs a keyword (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await purviewSearchAssets(conn(f.impl), '');
  assert.ok(!r.ok && /keyword/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('getAsset needs a guid; shapes the entity', async () => {
  const f0 = fakeFetch(() => ({ status: 200, body: {} }));
  assert.ok(!(await purviewGetAsset(conn(f0.impl), '')).ok);
  assert.equal(f0.calls.length, 0);
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/catalog/api/atlas/v2/entity/guid/a1'));
    return { status: 200, body: { entity: { guid: 'a1', typeName: 'azure_sql_table', attributes: { name: 'orders', qualifiedName: 'mssql://x/orders' } } } };
  });
  const r = await purviewGetAsset(conn(f.impl), 'a1');
  assert.ok(r.ok && r.data.name === 'orders' && r.data.typeName === 'azure_sql_table');
});

test('listClassifications shapes the classification defs', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/catalog/api/atlas/v2/types/typedefs'));
    return { status: 200, body: { classificationDefs: [{ name: 'MICROSOFT.PERSONAL.EMAIL', description: 'email address' }] } };
  });
  const r = await purviewListClassifications(conn(f.impl));
  assert.ok(r.ok && r.data[0].name === 'MICROSOFT.PERSONAL.EMAIL');
});

test('getLineage shapes lineage edges', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/catalog/api/atlas/v2/lineage/a1'));
    return { status: 200, body: { relations: [{ fromEntityId: 'a1', toEntityId: 'a2' }] } };
  });
  const r = await purviewGetLineage(conn(f.impl), 'a1');
  assert.ok(r.ok && r.data[0].fromEntityId === 'a1' && r.data[0].toEntityId === 'a2');
});

test('no endpoint ⇒ honest refusal, no network call', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await purviewListClassifications({ baseUrl: '', token: TOKEN, fetchImpl: f.impl });
  assert.ok(!r.ok && /endpoint/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable guid → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await purviewGetAsset(conn(f.impl), 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('health: typedefs 2xx → connected; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { classificationDefs: [{ name: 'A' }, { name: 'B' }] } }));
  const h = await purviewHealth(conn(up.impl));
  assert.ok(h.connected && /2 classification defs/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await purviewHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '15' } }));
  const r = await purviewListClassifications(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /15/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await purviewListClassifications({ baseUrl: 'https://acme.purview.azure.com', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { classificationDefs: [] } }));
  await purviewListClassifications({ baseUrl: 'https://acme.purview.azure.com', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});

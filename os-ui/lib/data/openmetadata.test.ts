/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMetadataHealth,
  fetchOpenMetadataTables,
  omEntityUrl,
  openMetadataSource,
  detectOmVersion,
  listOmDomains,
  listOmDataProducts,
  listOmTables,
  searchOmCatalog,
  getOmLineage,
  type OmFetch,
} from './openmetadata.ts';

/** A one-shot fake fetch that returns a canned Response, recording the request. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown } | Error,
): { fetch: OmFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const out = handler(String(url), init);
    if (out instanceof Error) throw out;
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
    } as Response;
  }) as OmFetch;
  return { fetch: fetchImpl, calls };
}

// ------------------------------------------------------------------- health probe --

test('openMetadataHealth reports CONNECTED + version on a 200 version response', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { version: '1.5.6' } }));
  const h = await openMetadataHealth({ apiUrl: 'http://om:8585', fetchImpl: fetch });
  assert.equal(h.connected, true);
  assert.equal(h.version, '1.5.6');
  assert.match(calls[0], /\/api\/v1\/system\/version$/);
});

test('openMetadataHealth counts a 401 as CONNECTED (server is up, just unauthenticated)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 401 }));
  const h = await openMetadataHealth({ apiUrl: 'http://om:8585', fetchImpl: fetch });
  assert.equal(h.connected, true);
  assert.equal(h.version, undefined);
});

test('openMetadataHealth reports DISCONNECTED on a network error/timeout', async () => {
  const { fetch } = fakeFetch(() => new Error('ECONNREFUSED'));
  const h = await openMetadataHealth({ apiUrl: 'http://om:8585', fetchImpl: fetch });
  assert.equal(h.connected, false);
  assert.equal(h.reason, 'unreachable');
});

// --------------------------------------------------------------------- table pull --

test('fetchOpenMetadataTables shapes OM tables into labelled CatalogAssets', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    body: { data: [{ name: 'orders', fullyQualifiedName: 'trino.iceberg.sales.orders', description: 'orders mart' }] },
  }));
  const assets = await fetchOpenMetadataTables({ apiUrl: 'http://om:8585', jwt: 'tok', fetchImpl: fetch });
  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0], {
    name: 'orders',
    fqn: 'trino.iceberg.sales.orders',
    description: 'orders mart',
    type: 'table',
    source: 'openmetadata',
  });
  assert.match(calls[0], /\/api\/v1\/tables\?/);
});

test('fetchOpenMetadataTables throws on a non-OK response (caller degrades honestly)', async () => {
  const { fetch } = fakeFetch(() => ({ status: 403 }));
  await assert.rejects(
    () => fetchOpenMetadataTables({ apiUrl: 'http://om:8585', jwt: 'tok', fetchImpl: fetch }),
    /OpenMetadata 403/,
  );
});

// -------------------------------------------------------------------- deep links --

test('omEntityUrl builds the OM entity URL for a governed Iceberg mart', () => {
  const url = omEntityUrl('https://om.example.com', 'trino', 'iceberg.sales.gold_orders');
  assert.equal(url, 'https://om.example.com/table/trino.iceberg.sales.gold_orders');
});

test('omEntityUrl returns null for a non-Iceberg FQN or a missing console base', () => {
  assert.equal(omEntityUrl('https://om.example.com', 'trino', 'registry:abc123'), null);
  assert.equal(omEntityUrl('', 'trino', 'iceberg.sales.gold_orders'), null);
});

// -------------------------------------------------- composed source (the injected fn) --

test('openMetadataSource: connected + token pulls tables and reads ok', async () => {
  const { fetch } = fakeFetch((url) =>
    url.includes('/system/version')
      ? { status: 200, body: { version: '1.5.6' } }
      : { status: 200, body: { data: [{ name: 't', fullyQualifiedName: 'trino.iceberg.s.t' }] } },
  );
  const s = await openMetadataSource({ apiUrl: 'http://om:8585', jwt: 'tok', fetchImpl: fetch, mirroredMarts: 3 });
  assert.equal(s.connected, true);
  assert.equal(s.ok, true);
  assert.equal(s.count, 1);
  assert.equal(s.assets?.length, 1);
  assert.match(s.status, /connected · v1\.5\.6/);
  assert.equal(s.severity, 'ok');
});

test('openMetadataSource: connected WITHOUT a token stays ok and mirrors governed marts (not "optional")', async () => {
  const { fetch } = fakeFetch(() => ({ status: 200, body: { version: '1.5.6' } }));
  const s = await openMetadataSource({ apiUrl: 'http://om:8585', fetchImpl: fetch, mirroredMarts: 2 });
  assert.equal(s.connected, true);
  assert.equal(s.ok, true);
  assert.equal(s.assets, null);
  assert.equal(s.count, 2);
  assert.match(s.status, /connected/);
  assert.match(s.status, /2 governed marts mirrored/);
  assert.doesNotMatch(s.status, /optional|not connected/i);
  assert.equal(s.severity, 'ok');
});

test('openMetadataSource: unreachable OM degrades to a calm "reconnecting…" warn — never "optional/off"', async () => {
  const { fetch } = fakeFetch(() => new Error('ECONNREFUSED'));
  const s = await openMetadataSource({ apiUrl: 'http://om:8585', jwt: 'tok', fetchImpl: fetch });
  assert.equal(s.connected, false);
  assert.equal(s.ok, false);
  assert.equal(s.assets, null);
  assert.match(s.status, /reconnecting/i);
  assert.doesNotMatch(s.status, /optional|not connected|off/i);
  assert.equal(s.severity, 'warn');
});

test('openMetadataSource: connected but authenticated pull fails stays CONNECTED (ok), not dropped', async () => {
  const { fetch } = fakeFetch((url) =>
    url.includes('/system/version') ? { status: 200, body: { version: '1.5.6' } } : { status: 500 },
  );
  const s = await openMetadataSource({ apiUrl: 'http://om:8585', jwt: 'tok', fetchImpl: fetch, mirroredMarts: 4 });
  assert.equal(s.connected, true);
  assert.equal(s.ok, true);
  assert.equal(s.assets, null);
  assert.match(s.status, /connected/);
  assert.match(s.status, /degraded/);
  assert.equal(s.severity, 'ok');
});

// ============================================================================
// PER-CONNECTION CLIENT (Phase 1 — external OM read/discover only)
// ============================================================================

/** A fake fetch that records the URL AND the request headers, so we can assert
 *  the Bearer token is injected exactly once and never leaks into the URL/body. */
function fakeConnFetch(
  handler: (url: string) => { status: number; body?: unknown } | Error,
): { fetch: OmFetch; reqs: { url: string; headers: Record<string, string> }[] } {
  const reqs: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    reqs.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const out = handler(String(url));
    if (out instanceof Error) throw out;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body } as Response;
  }) as OmFetch;
  return { fetch: fetchImpl, reqs };
}

test('per-connection client builds the right URLs and injects the Bearer token (no leak)', async () => {
  const { fetch, reqs } = fakeConnFetch(() => ({ status: 200, body: { data: [] } }));
  const conn = { baseUrl: 'http://ext-om:8585/', token: 'bot-jwt-123', fetchImpl: fetch };

  await listOmDomains(conn);
  await listOmDataProducts(conn);
  await listOmTables(conn);

  // Trailing slash on baseUrl is normalised; each path is well-formed.
  assert.match(reqs[0].url, /^http:\/\/ext-om:8585\/api\/v1\/domains\?limit=50$/);
  assert.match(reqs[1].url, /^http:\/\/ext-om:8585\/api\/v1\/dataProducts\?limit=50$/);
  assert.match(reqs[2].url, /\/api\/v1\/tables\?limit=50&fields=description,owners,tags$/);

  // The token is a Bearer header — NEVER in any URL (no token leak).
  for (const r of reqs) {
    assert.equal(r.headers.authorization, 'Bearer bot-jwt-123');
    assert.doesNotMatch(r.url, /bot-jwt-123/);
  }
});

test('per-connection client omits the Authorization header when no token is set', async () => {
  const { fetch, reqs } = fakeConnFetch(() => ({ status: 200, body: { version: '1.6.0' } }));
  await detectOmVersion({ baseUrl: 'http://ext-om:8585', fetchImpl: fetch });
  assert.equal(reqs[0].headers.authorization, undefined);
});

test('detectOmVersion parses the OM build version (version detection)', async () => {
  const { fetch } = fakeConnFetch((url) =>
    url.includes('/system/version') ? { status: 200, body: { version: '1.6.0' } } : { status: 404 },
  );
  const v = await detectOmVersion({ baseUrl: 'http://ext-om:8585', token: 't', fetchImpl: fetch });
  assert.equal(v, '1.6.0');
});

test('detectOmVersion returns undefined (never throws) when OM is unreachable', async () => {
  const { fetch } = fakeConnFetch(() => new Error('ECONNREFUSED'));
  const v = await detectOmVersion({ baseUrl: 'http://ext-om:8585', fetchImpl: fetch });
  assert.equal(v, undefined);
});

test('listOmTables shapes rows into om-sourced CatalogAssets', async () => {
  const { fetch } = fakeConnFetch(() => ({
    status: 200,
    body: { data: [{ name: 'orders', fullyQualifiedName: 'trino.iceberg.sales.orders', description: 'd' }] },
  }));
  const r = await listOmTables({ baseUrl: 'http://ext-om:8585', token: 't', fetchImpl: fetch });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].source, 'openmetadata');
    assert.equal(r.data[0].fqn, 'trino.iceberg.sales.orders');
  }
});

test('reads NEVER throw — a non-OK status degrades to an honest reason', async () => {
  const { fetch } = fakeConnFetch(() => ({ status: 403 }));
  const conn = { baseUrl: 'http://ext-om:8585', token: 't', fetchImpl: fetch };
  const d = await listOmDomains(conn);
  assert.equal(d.ok, false);
  if (!d.ok) assert.match(d.reason, /403/);

  const l = await getOmLineage(conn, 'trino.iceberg.sales.orders');
  assert.equal(l.ok, false);
});

test('searchOmCatalog shapes Elasticsearch-style hits into CatalogAssets', async () => {
  const { fetch, reqs } = fakeConnFetch((url) =>
    url.includes('/search/query')
      ? { status: 200, body: { hits: { hits: [{ _source: { name: 'orders', fullyQualifiedName: 'trino.iceberg.sales.orders', entityType: 'table' } }] } } }
      : { status: 404 },
  );
  const r = await searchOmCatalog({ baseUrl: 'http://ext-om:8585', token: 't', fetchImpl: fetch }, 'orders');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].name, 'orders');
    assert.equal(r.data[0].source, 'openmetadata');
  }
  assert.match(reqs[0].url, /\/api\/v1\/search\/query\?q=orders&size=25$/);
});

test('getOmLineage builds the lineage path for an entity FQN', async () => {
  const { fetch, reqs } = fakeConnFetch(() => ({ status: 200, body: { nodes: [] } }));
  const r = await getOmLineage({ baseUrl: 'http://ext-om:8585', token: 't', fetchImpl: fetch }, 'trino.iceberg.sales.orders');
  assert.ok(r.ok);
  assert.match(reqs[0].url, /\/api\/v1\/lineage\/table\/name\/trino\.iceberg\.sales\.orders$/);
});

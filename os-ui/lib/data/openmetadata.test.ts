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

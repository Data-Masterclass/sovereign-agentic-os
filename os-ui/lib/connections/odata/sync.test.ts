/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * OData slice runner (operational-system-connections.md, Phase 4) — cursor detection
 * honesty + full-refresh, over a MOCKED client (no real network, no secrets). Verifies:
 *   • append against an entity WITHOUT a detected change-timestamp fails honestly,
 *   • a full-refresh streams `replace` on the first batch and stamps lineage,
 *   • an entity WITH a detected cursor allows incremental (append) and windows on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runODataSlice } from './sync.ts';
import type { OdConn } from './client.ts';

// A fake OData service: `$metadata` returns fixture EDMX; entity-set pages return canned rows.
function fakeService(edmx: string, pages: Record<string, unknown>): OdConn['fetchImpl'] {
  return async (url: string) => {
    if (url.includes('/$metadata')) {
      return new Response(edmx, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    // Return the first matching canned page for the set in the URL.
    for (const [set, body] of Object.entries(pages)) {
      if (url.includes(`/${set}?`) || url.includes(`/${set}(`)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('[]', { status: 200 });
  };
}

const V4_WITH_CURSOR = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Account"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Guid"/>
      <Property Name="Name" Type="Edm.String"/>
      <Property Name="ModifiedOn" Type="Edm.DateTimeOffset"/>
    </EntityType>
    <EntityContainer Name="S"><EntitySet Name="Accounts" EntityType="X.Account"/></EntityContainer>
  </Schema></edmx:DataServices></edmx:Edmx>`;

const V4_NO_CURSOR = `<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
    <EntityType Name="Product"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.Guid"/>
      <Property Name="Price" Type="Edm.Decimal"/>
    </EntityType>
    <EntityContainer Name="S"><EntitySet Name="Products" EntityType="X.Product"/></EntityContainer>
  </Schema></edmx:DataServices></edmx:Edmx>`;

function baseArgs(overrides: Partial<Parameters<typeof runODataSlice>[0]>): Parameters<typeof runODataSlice>[0] {
  return {
    connectionId: 'conn_x',
    owner: { id: 'u1', domains: ['sales'], role: 'builder' } as never,
    entitySet: 'Accounts',
    mode: 'full-refresh',
    watermark: null,
    datasetSlug: 'accts',
    target: { schema: 'sales', table: 'bronze_accts' } as never,
    identity: { principal: 'sales', uid: 'u1', domains: ['sales'], role: 'builder' } as never,
    execute: async () => ({ rowsAffected: 0 }),
    mkBatchId: (hw) => `accts.${hw}`,
    startedAt: '2026-08-05T00:00:00.000Z',
    ingestUrl: 'http://data-runner:8000',
    ...overrides,
  };
}

test('OData append on a cursorless entity fails honestly (full-refresh only)', async () => {
  const fetchImpl = fakeService(V4_NO_CURSOR, {});
  const resolve = async (): Promise<OdConn> => ({ serviceRoot: 'https://host/svc', authType: 'basic', user: 'u', pass: 'p', fetchImpl });
  await assert.rejects(
    runODataSlice(baseArgs({ entitySet: 'Products', mode: 'append', watermark: '2026-01-01T00:00:00Z', resolve, fetchImpl })),
    /no detected change-timestamp property — incremental sync is not supported/,
  );
});

test('OData full-refresh streams replace on the first batch + stamps lineage', async () => {
  const ingested: { mode: string; rows: Record<string, unknown>[] }[] = [];
  const fetchImpl: OdConn['fetchImpl'] = async (url, init) => {
    if (String(url).includes('/ingest-rows')) {
      ingested.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return fakeService(V4_NO_CURSOR, { Products: { value: [{ Id: 'g1', Price: 10 }, { Id: 'g2', Price: 20 }] } })(String(url), init);
  };
  const resolve = async (): Promise<OdConn> => ({ serviceRoot: 'https://host/svc', authType: 'basic', user: 'u', pass: 'p', fetchImpl });
  const out = await runODataSlice(baseArgs({ entitySet: 'Products', mode: 'full-refresh', watermark: null, resolve, fetchImpl }));
  assert.equal(out.rowsAffected, 2);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].mode, 'replace'); // first batch of a first load
  assert.equal(ingested[0].rows[0]._batch_id, out.batchId);
  assert.equal(ingested[0].rows[0]._loaded_at, '2026-08-05T00:00:00.000Z');
});

test('OData incremental (append) allowed when a cursor is detected; windows on it', async () => {
  const urls: string[] = [];
  const fetchImpl: OdConn['fetchImpl'] = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('/ingest-rows')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (String(url).includes('/$metadata')) return new Response(V4_WITH_CURSOR, { status: 200 });
    // The desc probe (top 1) returns the max cursor; the slice page returns one row.
    if (String(url).includes('orderby=ModifiedOn+desc') || String(url).includes('orderby=ModifiedOn%20desc')) {
      return new Response(JSON.stringify({ value: [{ ModifiedOn: '2026-08-04T12:00:00Z' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ value: [{ Id: 'a1', Name: 'Acme', ModifiedOn: '2026-08-03T00:00:00Z' }] }), { status: 200 });
  };
  const resolve = async (): Promise<OdConn> => ({ serviceRoot: 'https://host/svc', authType: 'basic', user: 'u', pass: 'p', fetchImpl });
  const out = await runODataSlice(baseArgs({
    entitySet: 'Accounts', mode: 'append', watermark: '2026-08-01T00:00:00Z', resolve, fetchImpl,
    execute: async () => ({ rowsAffected: 0 }),
  }));
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, '2026-08-04T12:00:00Z'); // probed max cursor
  // The slice page URL carries a $filter windowing on ModifiedOn (gt watermark, le hw).
  const sliceUrl = urls.find((u) => u.includes('%24filter') || u.includes('$filter'));
  assert.ok(sliceUrl, 'the slice page should carry a $filter window');
  assert.ok(/ModifiedOn/.test(decodeURIComponent(sliceUrl!)));
});

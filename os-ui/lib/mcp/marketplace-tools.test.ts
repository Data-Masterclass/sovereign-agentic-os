/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { __resetMarketplace, mockCatalog } from '@/lib/marketplace/store';

/** Seed one certified listing into the offline mock catalogue (fresh tenant = empty). */
const LISTING_ID = 'mkt_test_ds';
function seedListing(): string {
  const catalog = mockCatalog();
  if (!catalog.some((p) => p.id === LISTING_ID)) {
    catalog.push({
      id: LISTING_ID,
      type: 'dataset',
      name: 'Certified revenue mart',
      description: 'Governed gold revenue dataset, certified for reuse.',
      owner: 'owner_fin',
      ownerDomain: 'finance',
      tags: ['revenue', 'finance'],
      registry: 'openmetadata',
      quality: 0.9,
      freshness: 0.85,
      previewColumns: ['region', 'revenue'],
      previewRows: [['sales', '100'], ['finance', '200']],
    });
  }
  return LISTING_ID;
}

/**
 * MARKETPLACE SURFACE (mcp-v2 P3) — browse/get/rate over the SAME certified
 * catalogue + adapters the tab uses. Consuming shared assets floors at creator;
 * the RLS-filtered preview is the adapter's, never re-implemented here. Offline
 * against the mock catalogue.
 */

const salesCreator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

test('MARKETPLACE registry: browse/get read at creator, rate is a creator write, all under marketplace tab', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  const tabNames = new Set(toolsForTab('marketplace').map((t) => t.name));
  for (const n of ['browse_marketplace', 'get_listing', 'rate_listing']) {
    const t = byName.get(n)!;
    assert.ok(t, `${n} registered`);
    assert.equal(t.minRole, 'creator', `${n} floors at creator`);
    assert.equal(t.tab, 'marketplace');
    assert.ok(tabNames.has(n), `${n} on the marketplace tab`);
    assert.ok((t.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
  }
  assert.ok(!writeNames.has('browse_marketplace') && !writeNames.has('get_listing'), 'browse/get are read-only');
  assert.ok(writeNames.has('rate_listing'), 'rate_listing in ALL_WRITE_TOOLS');
  // import_product (P0) also rides the marketplace tab.
  assert.ok(tabNames.has('import_product'), 'import_product surfaces on marketplace');
});

test('MARKETPLACE happy path: a creator browses, reads one listing, and rates it', async () => {
  __resetMarketplace();
  const id = seedListing();
  const listings = payload<{ id: string; name: string }[]>(await call(salesCreator, 'browse_marketplace', {}));
  assert.ok(listings.some((l) => l.id === id), 'the seeded certified listing is browsable');

  const detail = payload<{ id: string; preview: unknown; lineage: unknown[]; myGrants: unknown[]; source: string }>(
    await call(salesCreator, 'get_listing', { listingId: id }),
  );
  assert.equal(detail.id, id);
  assert.ok('preview' in detail, 'the RLS-filtered preview is returned');
  assert.ok(Array.isArray(detail.myGrants), 'my grants are returned (empty before import)');

  const rated = payload<{ rating: number; ratingCount: number; yourRating: number }>(
    await call(salesCreator, 'rate_listing', { listingId: id, stars: 5 }),
  );
  assert.equal(rated.yourRating, 5);
  assert.ok(rated.ratingCount >= 1, 'the aggregate reflects the new rating');
});

test('MARKETPLACE negative — an unknown listing is not_found', async () => {
  __resetMarketplace();
  const err = errorOf(await call(salesCreator, 'get_listing', { listingId: 'lst_nope' }));
  assert.equal(err.code, 'not_found');
});

test('MARKETPLACE negative — an out-of-range rating is bad_request', async () => {
  __resetMarketplace();
  const id = seedListing();
  const err = errorOf(await call(salesCreator, 'rate_listing', { listingId: id, stars: 9 }));
  assert.equal(err.code, 'bad_request');
});

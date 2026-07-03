/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * `retrieveTool` DLS test — the governed RAG tool must apply DOCUMENT-LEVEL
 * SECURITY per unit, so a caller can never read another domain's private
 * knowledge even when OpenSearch hands back matching rows. We stub `fetch` to
 * return cross-domain hits and assert only the ones the principal may see survive.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveTool } from './agent-governed.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubHits(hits: { _id: string; _source: Record<string, unknown> }[]) {
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => JSON.stringify({ hits: { hits } }),
  })) as unknown as typeof fetch;
}

const marketingCreator = { id: 'cara', domains: ['marketing'], role: 'creator' as const };

test('SECURITY: retrieveTool drops cross-domain Personal/Shared units; keeps Marketplace', async () => {
  stubHits([
    { _id: 'a', _source: { title: 'Sales private', text: 'x', domain: 'sales', owner: 'sara', visibility: 'Personal' } },
    { _id: 'b', _source: { title: 'Certified metric', text: 'y', visibility: 'Marketplace', certified: true } },
    { _id: 'c', _source: { title: 'Sales shared', text: 'z', domain: 'sales', visibility: 'Shared' } },
  ]);
  const passages = await retrieveTool('anything', marketingCreator);
  const titles = passages.map((p) => p.title);
  assert.deepEqual(titles, ['Certified metric'], 'only the Marketplace unit is visible cross-domain');
});

test('a domain member sees their own domain Shared units', async () => {
  stubHits([
    { _id: 'c', _source: { title: 'Sales shared', text: 'z', domain: 'sales', visibility: 'Shared' } },
  ]);
  const salesUser = { id: 'sam', domains: ['sales'], role: 'creator' as const };
  const passages = await retrieveTool('anything', salesUser);
  assert.deepEqual(passages.map((p) => p.title), ['Sales shared']);
});

test('globalThis pin: create survives a fresh bundles() call', async () => {
  const { registerConnectionProfile, connectionBundle } = await import('./agent-governed.ts');
  registerConnectionProfile('crm-conn', [{ name: 'list_contacts', mode: 'Read', write: false }]);

  // Confirm entry is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.agentGoverned.bundles')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has('crm-conn'), 'bundle visible via globalThis pin');

  // connectionBundle() calls bundles() afresh — must still return the bundle.
  assert.ok(connectionBundle('crm-conn') !== null);
});

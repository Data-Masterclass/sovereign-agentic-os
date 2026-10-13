/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * End-to-end wiring for the Notion hosted-MCP OAuth flow at the connections layer:
 *   • createConnection('notion-mcp') mints the offline placeholder (NOT connected);
 *   • the CALLBACK sink (`storeNotionConnection`) persists the token set + client;
 *   • `verifyNotionConnection` proves liveness with a real MCP tools/list round-trip
 *     through an injected fetch, and lists the server's tools;
 *   • governance: only the OWNER may complete/verify;
 *   • the token/client secret NEVER appear in the connection record (ref only).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  createConnection,
  storeNotionConnection,
  verifyNotionConnection,
  getNotionClientReg,
  __resetConnections,
} = await import('./store.ts');

const owner = { id: 'nora', name: 'Nora', domains: ['sales'], role: 'creator' as const };
const nowSec = () => Math.floor(Date.now() / 1000);
const REG = { clientId: 'cid-1', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' };

beforeEach(() => __resetConnections());

async function makeNotion() {
  return createConnection(owner, { name: 'My Notion', template: 'notion-mcp', endpoint: '', credential: '' });
}

/** An injected MCP fetch double: initialize → 202 notif → tools/list. */
function mcpFetch(tools: { name: string }[]): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body));
    const mk = (json: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({
      ok: true, status: 200, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => json, text: async () => JSON.stringify(json),
    } as unknown as Response);
    if (msg.method === 'initialize') return mk({ jsonrpc: '2.0', id: 1, result: {} }, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
    if (msg.method === 'notifications/initialized') return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({}), text: async () => '' } as unknown as Response;
    return mk({ jsonrpc: '2.0', id: 2, result: { tools } });
  }) as unknown as typeof fetch;
}

test('a fresh Notion connection is NOT connected and holds no client reg', async () => {
  const c = await makeNotion();
  assert.equal(c.template, 'notion-mcp');
  assert.equal(c.auth, 'oauth');
  assert.equal(c.health, 'untested', 'placeholder token only → not connected');
  assert.equal(getNotionClientReg(c), null);
  const v = await verifyNotionConnection(c.id, owner.id);
  assert.equal(v.ok, false, 'cannot verify before connecting');
});

test('callback stores token+client; verify proves liveness via a real tools/list', async () => {
  const c = await makeNotion();
  const connected = await storeNotionConnection(c.id, owner.id, { accessToken: 'AT', refreshToken: 'RT', expiresAt: nowSec() + 3600 }, REG);
  assert.equal(connected.health, 'healthy');
  assert.ok(connected.secretFingerprint.startsWith('sha256:'), 'fingerprint shown, not the token');
  assert.equal(JSON.stringify(connected).includes('AT'), false, 'the raw token never appears in the record');

  const v = await verifyNotionConnection(c.id, owner.id, { fetchImpl: mcpFetch([{ name: 'notion_search' }, { name: 'notion_fetch' }]) });
  assert.equal(v.ok, true);
  assert.deepEqual(v.tools.map((t) => t.name), ['notion_search', 'notion_fetch']);
});

test('an expired token is refreshed before tools/list', async () => {
  const c = await makeNotion();
  await storeNotionConnection(c.id, owner.id, { accessToken: 'old', refreshToken: 'RT', expiresAt: nowSec() - 10 }, REG);
  let refreshed = false;
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = url.toString();
    if (u === REG.tokenEndpoint) {
      refreshed = true;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: 'AT2', expires_in: 3600 }), text: async () => '' } as unknown as Response;
    }
    return (mcpFetch([{ name: 'notion_search' }]) as (i: RequestInfo | URL, x?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
  const v = await verifyNotionConnection(c.id, owner.id, { fetchImpl: f });
  assert.equal(refreshed, true, 'the stale token was refreshed');
  assert.equal(v.ok, true);
});

test('governance: only the owner can complete or verify the Notion flow', async () => {
  const c = await makeNotion();
  await assert.rejects(storeNotionConnection(c.id, 'intruder', { accessToken: 'x', expiresAt: nowSec() + 3600 }, REG), /owner/i);
  await storeNotionConnection(c.id, owner.id, { accessToken: 'AT', refreshToken: 'RT', expiresAt: nowSec() + 3600 }, REG);
  await assert.rejects(verifyNotionConnection(c.id, 'intruder'), /not found/i);
});

test('restore real fetch', () => {
  globalThis.fetch = _realFetch;
});

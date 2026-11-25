/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Connections "Test" of MCP and account connectors is a real authenticated round-trip
 * USER STORY: As a user I want "Test" on my Notion, Microsoft 365, Google Drive or MCP server connection to
 *             prove that MY sign-in works (MCP initialize + tools/list, or the cheapest authenticated read),
 *             to say exactly what to do when it does not, and to look neutral when there is nothing to check yet.
 * ARCHITECTURE: the REAL connections store (`testConnection` → `testAccountConnection`), the real credential
 *   resolution (`resolveAccountSession`), the real MCP client against the Notion MCP stub over HTTP, and a
 *   fake Microsoft Graph. OPA's answer is injected (`decide`). Each outcome has its negative twin:
 *   verified vs not connected, expired, 401, egress denied, no credential, policy denied.
 */
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { DecideFn } from '@core/runtime/external-mcp';
import { startNotionStub, fetchToStub, type NotionStub } from '@core/testing/notion-mcp-stub';
import { fakeApi } from '@core/testing/account-fixtures';
import { testMessage } from '@tabs/connections/lib/test-result';
import type { TokenSet } from '@core/auth/token-set';

const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const store = await import('@tabs/connections/lib/store');

const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'domain_admin' };
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const nowSec = () => Math.floor(Date.now() / 1000);
const tok = (accessToken: string, ttl = 3600): TokenSet => ({ accessToken, refreshToken: `R-${accessToken}`, expiresAt: nowSec() + ttl });
const REG = { clientId: 'cid', tokenEndpoint: 'https://mcp.notion.com/token', mcpEndpoint: 'https://mcp.notion.com/mcp', resource: 'https://mcp.notion.com/mcp' };

const allow: DecideFn = async () => ({ effect: 'allow', reason: 'read' });
const deny: DecideFn = async () => ({ effect: 'deny', reason: 'connection_not_visible' });

let notion: NotionStub;
before(async () => { notion = await startNotionStub([{ id: 'p1', title: 'Q3', url: 'https://www.notion.so/p1', text: '# Q3', lastEdited: '2026-11-01T00:00:00Z' }], ['N-BEN', 'MCP-SECRET']); });
after(async () => { await notion.close(); globalThis.fetch = realFetch; });

let graph: ReturnType<typeof fakeApi>;
const vendor = (): typeof fetch => {
  const n = fetchToStub(notion);
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://graph.microsoft.com') ? graph.fetch(input, init) : n(input, init)) as typeof fetch;
};
beforeEach(() => {
  store.__resetConnections();
  delete process.env.OS_EGRESS_ALLOWLIST;
  graph = fakeApi([{ match: /\/v1\.0\/me\?/, reply: () => ({ json: { userPrincipalName: 'ben@example.com' } }) }]);
});
const run = (connId: string, user: CurrentUser, decide: DecideFn = allow) => store.testConnection(connId, user, { fetchImpl: vendor(), decide });

// ---------------------------------------------------------------- Notion ---

test('Notion per-user: verified by MCP initialize + tools/list with the caller\'s own sign-in, with the tool count', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'notion', scope: 'domain' });
  await store.completeAccountOAuth(c.id, ben, tok('N-BEN'), { reg: REG });
  const r = await run(c.id, ben);
  assert.equal(r.state, 'verified', JSON.stringify(r));
  assert.equal(r.ok, true);
  assert.ok((r.toolCount ?? 0) > 0);
  assert.match(r.detail, /initialize and tools\/list/);
  assert.equal(JSON.stringify(r).includes('N-BEN'), false, 'never a token');
  assert.match(testMessage(r), /^✓ /);
});

test('TWIN: not connected yet is NEUTRAL "not verified yet" with the connect hint — never a red ✗', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'notion', scope: 'domain' });
  const r = await run(c.id, ben);
  assert.deepEqual([r.ok, r.state, r.code], [false, 'not_verified', 'needs_connect']);
  assert.match(r.hint ?? '', /Connect your Notion account/);
  assert.match(testMessage(r), /^○ Not verified yet/);
});

test('TWIN: an expired sign-in that cannot be refreshed is a failure that says Reconnect', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'notion', scope: 'domain' });
  notion.mode.refuseRefresh = true;
  try {
    await store.completeAccountOAuth(c.id, ben, tok('N-OLD', -10), { reg: REG });
    const r = await run(c.id, ben);
    assert.deepEqual([r.state, r.code], ['failed', 'sign_in_expired']);
    assert.match(`${r.detail} ${r.hint}`, /expired.*(Reconnect|sign in again)/i);
    assert.match(testMessage(r), /^✗ /);
  } finally {
    notion.mode.refuseRefresh = false;
  }
});

test('TWIN: a token the MCP server refuses (401) is a failure that says Reconnect', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'notion', scope: 'domain' });
  await store.completeAccountOAuth(c.id, ben, tok('N-REVOKED'), { reg: REG });
  const r = await run(c.id, ben);
  assert.deepEqual([r.state, r.code], ['failed', 'unauthorized']);
  assert.match(r.hint ?? '', /Reconnect/);
});

// ---------------------------------------------------------------- Microsoft 365 ---

test('Microsoft 365 per-user: verified by an authenticated Graph read, naming the account and the tool count', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('M-BEN'));
  const r = await run(c.id, ben);
  assert.equal(r.state, 'verified', JSON.stringify(r));
  assert.match(r.detail, /ben@example\.com/);
  assert.ok((r.toolCount ?? 0) >= 5);
  assert.equal(graph.calls.at(-1)?.token, 'M-BEN', 'the caller\'s own token, nobody else\'s');
});

test('TWIN: Graph answering 401 is "refused the sign-in — Reconnect"', async () => {
  graph = fakeApi([{ match: /./, reply: () => ({ status: 401, json: {} }) }]);
  const c = await store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('M-BAD'));
  const r = await run(c.id, ben);
  assert.deepEqual([r.state, r.code], ['failed', 'unauthorized']);
});

test('TWIN: an egress allowlist without Graph blocks the test before any call', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('M-BEN'));
  process.env.OS_EGRESS_ALLOWLIST = 'example.com'; // the admin removed Graph from the allowlist later
  const r = await run(c.id, ben);
  assert.deepEqual([r.state, r.code], ['failed', 'egress_blocked']);
  assert.equal(graph.calls.length, 0, 'nothing left the OS');
});

test('TWIN: a policy deny stops the test before the credential is used', async () => {
  const c = await store.createAccountConnection(dana, { kind: 'microsoft-365', scope: 'domain' });
  await store.storeUserAccountCredential(c.id, ben.id, tok('M-BEN'));
  const r = await run(c.id, ben, deny);
  assert.deepEqual([r.state, r.code], ['failed', 'policy_denied']);
  assert.equal(graph.calls.length, 0);
});

// ---------------------------------------------------------------- generic MCP ---

test('generic MCP server: verified with its stored bearer token by initialize + tools/list', async () => {
  const builder: CurrentUser = { ...dana, role: 'builder' };
  const c = await store.createConnection(builder, { name: 'Docs MCP', template: 'generic-mcp', endpoint: 'https://mcp.notion.com/mcp', credential: 'MCP-SECRET' });
  const r = await run(c.id, builder);
  assert.equal(r.state, 'verified', JSON.stringify(r));
  assert.ok((r.toolCount ?? 0) > 0);
});

test('TWIN: generic MCP server with a refused token is unauthorized; with no credential it is neutral "not verified yet"', async () => {
  const builder: CurrentUser = { ...dana, role: 'builder' };
  const bad = await store.createConnection(builder, { name: 'Bad MCP', template: 'generic-mcp', endpoint: 'https://mcp.notion.com/mcp', credential: 'WRONG' });
  assert.equal((await run(bad.id, builder)).code, 'unauthorized');
  const none = await store.createConnection(builder, { name: 'Empty MCP', template: 'generic-mcp', endpoint: 'https://mcp.notion.com/mcp', credential: '' });
  const { deleteSecret } = await import('@core/infra/secrets');
  deleteSecret(none.secretRef);
  const r = await run(none.id, builder);
  assert.deepEqual([r.state, r.code], ['not_verified', 'no_credential']);
  assert.match(testMessage(r), /^○ /);
});

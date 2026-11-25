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

// ---------------------------------------------------------------- verifier follow-ups ---

/** A hand-written MCP server for one test: `reply(method)` decides each JSON-RPC answer. Records every URL called. */
function probeServer(reply: (method: string, url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const msg = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    return reply(String(msg.method), String(input));
  }) as typeof fetch;
  return { fetch: f, urls };
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const builder: CurrentUser = { ...dana, role: 'builder' };

test('LEAK PROBE: a server that echoes the bearer in its JSON-RPC error never gets the token into the result', async () => {
  const SECRET = 'sk-live-THIS-MUST-NEVER-SHOW-0123456789';
  const c = await store.createConnection(builder, { name: 'Echo MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/mcp', credential: SECRET });
  const probe = probeServer(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: `bad Bearer ${SECRET} (token rejected)` } }));
  const r = await store.testConnection(c.id, builder, { fetchImpl: probe.fetch, decide: allow });
  assert.equal(r.code, 'remote_error', 'a JSON-RPC error is the server answering, not "could not be reached"');
  assert.equal(JSON.stringify(r).includes(SECRET), false, `the token leaked: ${JSON.stringify(r)}`);
  assert.equal(JSON.stringify(r).includes('THIS-MUST-NEVER-SHOW'), false);
});

test('SSRF: a 307 redirect to an internal host is refused before it is followed', async () => {
  const c = await store.createConnection(builder, { name: 'Redirecting MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/mcp', credential: 'MCP-SECRET' });
  const probe = probeServer((_m, url) => url.startsWith('https://mcp.example.com')
    ? new Response('', { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    : json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
  const r = await store.testConnection(c.id, builder, { fetchImpl: probe.fetch, decide: allow });
  assert.equal(r.code, 'redirect_refused', JSON.stringify(r));
  assert.deepEqual(probe.urls, ['https://mcp.example.com/mcp'], 'the internal address was never requested');
});

/** An MCP server that answers initialize / initialized / tools/list with two tools. */
const mcpOk = (m: string) => m === 'initialize' ? json({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 's1' })
  : m === 'notifications/initialized' ? new Response(null, { status: 202 })
  : json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }, { name: 'fetch' }] } });

for (const [what, location] of [
  ['another allowlisted host', 'https://api.example.com/mcp'],
  ['an https→http downgrade on the same host', 'http://mcp.example.com/mcp'],
  ['another port on the same host', 'https://mcp.example.com:8181/mcp'],
] as const) {
  test(`BEARER SAFETY: a 307 to ${what} is refused and the bearer is never sent there`, async () => {
    const c = await store.createConnection(builder, { name: `MCP ${what}`, template: 'generic-mcp', endpoint: 'https://mcp.example.com/old', credential: 'MCP-SECRET' });
    const seen: { url: string; auth: string }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? '') });
      return String(input).endsWith('/old') ? new Response('', { status: 307, headers: { location } }) : mcpOk(String(JSON.parse(String(init?.body ?? '{}')).method));
    }) as typeof fetch;
    const r = await store.testConnection(c.id, builder, { fetchImpl: f, decide: allow });
    assert.equal(r.code, 'redirect_refused', JSON.stringify(r));
    assert.deepEqual(seen.map((x) => x.url), ['https://mcp.example.com/old'], 'nothing was sent to the redirect target');
  });
}

test('TWIN: a same-origin relative 307 is followed (method, body and bearer stay on the same origin)', async () => {
  const c = await store.createConnection(builder, { name: 'Moved MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/old', credential: 'MCP-SECRET' });
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input));
    return String(input).endsWith('/old') ? new Response('', { status: 307, headers: { location: '/v2/mcp' } }) : mcpOk(String(JSON.parse(String(init?.body ?? '{}')).method));
  }) as typeof fetch;
  const r = await store.testConnection(c.id, builder, { fetchImpl: f, decide: allow });
  assert.equal(r.state, 'verified', JSON.stringify(r));
  assert.equal(r.toolCount, 2);
  assert.ok(seen.includes('https://mcp.example.com/v2/mcp'));
});

test('LEAK PROBE 2: a token split across lines in the server error never reaches the result (the remote text is not shown at all)', async () => {
  const SECRET = 'sk-live-SPLITSECRET-0123456789abcdef';
  const c = await store.createConnection(builder, { name: 'Split MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/mcp', credential: SECRET });
  const split = `${SECRET.slice(0, 12)}\n${SECRET.slice(12)}`;
  const probe = probeServer(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: `bad token:\n${split}\nbase64:${Buffer.from(SECRET).toString('base64')}` } }));
  const r = await store.testConnection(c.id, builder, { fetchImpl: probe.fetch, decide: allow });
  assert.equal(r.code, 'remote_error');
  const out = JSON.stringify(r);
  for (const part of [SECRET.slice(0, 12), SECRET.slice(12), Buffer.from(SECRET).toString('base64'), 'SPLITSECRET']) {
    assert.equal(out.includes(part), false, `leaked "${part}": ${out}`);
  }
});

test('shared state: a policy deny, a timeout or a remote error never flips an owner connection offline; a refused credential does', async () => {
  const c = await store.createConnection(builder, { name: 'Owned MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/mcp', credential: 'MCP-SECRET' });
  const ok = probeServer((m) => m === 'initialize' ? json({ jsonrpc: '2.0', id: 1, result: {} }) : m === 'notifications/initialized' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }] } }));
  await store.testConnection(c.id, builder, { fetchImpl: ok.fetch, decide: allow });
  const live = await store.getConnectionForUser(c.id, builder);
  assert.deepEqual([live.mode, live.health], ['live', 'healthy']);

  await store.testConnection(c.id, builder, { fetchImpl: ok.fetch, decide: deny });
  const timeout = probeServer(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  assert.equal((await store.testConnection(c.id, builder, { fetchImpl: timeout.fetch, decide: allow })).code, 'host_timeout');
  const rpcErr = probeServer(() => json({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'busy' } }));
  assert.equal((await store.testConnection(c.id, builder, { fetchImpl: rpcErr.fetch, decide: allow })).code, 'remote_error');
  const still = await store.getConnectionForUser(c.id, builder);
  assert.deepEqual([still.mode, still.health], ['live', 'healthy'], 'none of those changed the shared state');

  const refused = probeServer(() => json({ error: 'no' }, 401));
  assert.equal((await store.testConnection(c.id, builder, { fetchImpl: refused.fetch, decide: allow })).code, 'unauthorized');
  const after401 = await store.getConnectionForUser(c.id, builder);
  assert.deepEqual([after401.mode, after401.health], ['offline', 'needs-reconnect']);
});

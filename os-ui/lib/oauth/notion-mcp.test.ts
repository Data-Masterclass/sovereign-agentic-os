/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverMetadata,
  registerClient,
  buildNotionAuthorizeUrl,
  exchangeNotionCode,
  refreshNotionToken,
  listNotionMcpTools,
  serializeClientReg,
  parseClientReg,
  NOTION_MCP_ENDPOINT,
  type NotionMcpMetadata,
  type NotionClientReg,
} from './notion-mcp.ts';

// --- a tiny fetch double: Response-shaped, JSON or SSE bodies, header map -----

type Handler = (url: string, init?: RequestInit) => {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  throws?: boolean;
};

function fakeFetch(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url, init);
    if (r.throws) throw new Error('network down');
    const headers = r.headers ?? { 'content-type': 'application/json' };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const META: NotionMcpMetadata = {
  resource: NOTION_MCP_ENDPOINT,
  authorizeEndpoint: 'https://mcp.notion.com/authorize',
  tokenEndpoint: 'https://mcp.notion.com/token',
  registrationEndpoint: 'https://mcp.notion.com/register',
};
const REG: NotionClientReg = {
  clientId: 'cid-123',
  tokenEndpoint: META.tokenEndpoint,
  mcpEndpoint: NOTION_MCP_ENDPOINT,
  resource: NOTION_MCP_ENDPOINT,
};

test('discoverMetadata parses protected-resource + authorization-server metadata', async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return { json: { authorization_servers: ['https://auth.notion.com'] } };
    }
    if (url === 'https://auth.notion.com/.well-known/oauth-authorization-server') {
      return { json: {
        authorization_endpoint: 'https://auth.notion.com/authorize',
        token_endpoint: 'https://auth.notion.com/token',
        registration_endpoint: 'https://auth.notion.com/register',
      } };
    }
    return { ok: false, status: 404 };
  });
  const meta = await discoverMetadata({ fetchImpl: f });
  assert.equal(meta.authorizeEndpoint, 'https://auth.notion.com/authorize');
  assert.equal(meta.tokenEndpoint, 'https://auth.notion.com/token');
  assert.equal(meta.resource, NOTION_MCP_ENDPOINT);
});

test('discoverMetadata falls back to documented Notion endpoints when discovery is unreachable', async () => {
  const meta = await discoverMetadata({ fetchImpl: fakeFetch(() => ({ throws: true })) });
  assert.equal(meta.tokenEndpoint, 'https://mcp.notion.com/token');
  assert.equal(meta.authorizeEndpoint, 'https://mcp.notion.com/authorize');
});

test('registerClient (DCR) returns the public client id', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(url, META.registrationEndpoint);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.redirect_uris, ['https://os.example.com/cb']);
    assert.equal(body.token_endpoint_auth_method, 'none');
    return { json: { client_id: 'dyn-client-42' } };
  });
  const reg = await registerClient(META, 'https://os.example.com/cb', { fetchImpl: f });
  assert.equal(reg.clientId, 'dyn-client-42');
  assert.equal(reg.tokenEndpoint, META.tokenEndpoint);
  assert.equal(reg.clientSecret, undefined, 'public client has no secret');
});

test('buildNotionAuthorizeUrl carries PKCE S256 + resource binding', () => {
  const url = new URL(buildNotionAuthorizeUrl(META, {
    clientId: 'cid', redirectUri: 'https://os/cb', state: 'st', codeChallenge: 'chal',
  }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('resource'), NOTION_MCP_ENDPOINT);
});

test('exchangeNotionCode sends the PKCE verifier and returns a token set', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(url, META.tokenEndpoint);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'auth-code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(body.get('client_id'), 'cid-123');
    return { json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' } };
  });
  const ts = await exchangeNotionCode(REG, { code: 'auth-code', redirectUri: 'https://os/cb', codeVerifier: 'the-verifier' }, { fetchImpl: f, now: 1000 });
  assert.equal(ts.accessToken, 'AT');
  assert.equal(ts.refreshToken, 'RT');
  assert.equal(ts.expiresAt, 1000 + 3600);
});

test('refreshNotionToken uses the refresh grant and keeps the prior refresh token', async () => {
  const f = fakeFetch((_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'RT-old');
    return { json: { access_token: 'AT-new', expires_in: 3600 } }; // no new refresh token
  });
  const next = await refreshNotionToken(REG, { accessToken: 'x', refreshToken: 'RT-old', expiresAt: 0 }, { fetchImpl: f, now: 500 });
  assert.equal(next.accessToken, 'AT-new');
  assert.equal(next.refreshToken, 'RT-old', 'carries the prior refresh token when the provider omits one');
});

test('refreshNotionToken without a refresh token throws (reconnect)', async () => {
  await assert.rejects(
    () => refreshNotionToken(REG, { accessToken: 'x', expiresAt: 0 }, { fetchImpl: fakeFetch(() => ({ json: {} })) }),
    /reconnect/i,
  );
});

test('listNotionMcpTools runs initialize + tools/list and returns tool names', async () => {
  const calls: string[] = [];
  const f = fakeFetch((url, init) => {
    assert.equal(url, NOTION_MCP_ENDPOINT);
    const msg = JSON.parse(String(init?.body));
    calls.push(msg.method);
    const auth = (init?.headers as Record<string, string>)?.authorization;
    assert.equal(auth, 'Bearer live-token');
    if (msg.method === 'initialize') {
      return { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }, json: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } } };
    }
    if (msg.method === 'notifications/initialized') return { status: 202, headers: {} };
    if (msg.method === 'tools/list') {
      // exercise the SSE branch too
      return {
        headers: { 'content-type': 'text/event-stream' },
        text: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"notion_search","description":"Search"},{"name":"notion_fetch"}]}}\n\n',
      };
    }
    return { ok: false, status: 400 };
  });
  const tools = await listNotionMcpTools(REG, 'live-token', { fetchImpl: f });
  assert.deepEqual(tools.map((t) => t.name), ['notion_search', 'notion_fetch']);
  assert.ok(calls.includes('initialize') && calls.includes('tools/list'));
});

test('client-reg serialize/parse round-trips; junk parses to null', () => {
  const round = parseClientReg(serializeClientReg(REG));
  assert.ok(round);
  assert.equal(round!.clientId, REG.clientId);
  assert.equal(round!.tokenEndpoint, REG.tokenEndpoint);
  assert.equal(round!.mcpEndpoint, REG.mcpEndpoint);
  assert.equal(round!.resource, REG.resource);
  // a confidential client's secret round-trips too
  const withSecret = parseClientReg(serializeClientReg({ ...REG, clientSecret: 'shh' }));
  assert.equal(withSecret!.clientSecret, 'shh');
  assert.equal(parseClientReg('not-json'), null);
  assert.equal(parseClientReg('{"clientId":""}'), null);
});

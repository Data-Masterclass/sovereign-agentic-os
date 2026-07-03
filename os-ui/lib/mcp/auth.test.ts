/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signMcpToken, resolveMcpUser } from './token.ts';
import { handleRpc, type JsonRpcResponse } from './server.ts';
import { createUser } from '@/lib/users';

/**
 * The route's authentication boundary is `resolveMcpUser` (the route shell that
 * wraps it in `next/server` is a thin adapter verified by `next build`, and
 * `next/server` cannot load under `node --test`). These tests exercise the exact
 * auth path + a full initialize→tools/list→tools/call round-trip a real MCP
 * client drives, under a token-resolved identity.
 */

test('auth: a missing / invalid bearer token resolves to no identity (→ the route 401s)', async () => {
  assert.equal(await resolveMcpUser(null), null);
  assert.equal(await resolveMcpUser('Bearerless'), null);
  assert.equal(await resolveMcpUser('soa_mcp_bogus.sig'), null);
});

test('auth: a valid token resolves to the LIVE delegated identity, then drives the OS', async () => {
  await createUser({
    id: 'mcp-client',
    name: 'MCP Client',
    password: 'pw-strong-123',
    domains: ['sales'],
    role: 'admin',
    email: 'mcp-client@example.com',
  }).catch(() => {});
  const token = signMcpToken('mcp-client');

  const user = await resolveMcpUser(token);
  assert.equal(user?.id, 'mcp-client');
  assert.equal(user?.role, 'admin');

  // A real MCP client's opening sequence, under the resolved identity.
  const init = (await handleRpc(user!, { jsonrpc: '2.0', id: 1, method: 'initialize' })) as JsonRpcResponse;
  assert.ok((init.result as { protocolVersion: string }).protocolVersion);

  const list = (await handleRpc(user!, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as JsonRpcResponse;
  const names = ((list.result as { tools: { name: string }[] }).tools).map((t) => t.name);
  assert.ok(names.includes('create_software'));
  assert.ok(names.includes('promote')); // admin sees elevated tools

  const call = (await handleRpc(user!, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'create_software', arguments: { name: 'Via MCP client' } },
  })) as JsonRpcResponse;
  const r = call.result as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(r.isError, true);
  assert.match(r.content[0].text, /"id"/);
});

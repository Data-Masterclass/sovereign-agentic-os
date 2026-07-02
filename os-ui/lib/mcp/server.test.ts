/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, listToolsForRole, type JsonRpcResponse } from './server.ts';

const creator: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'participant' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

const ELEVATED = ['promote', 'decide_deploy', 'delete'];

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

test('initialize: returns the protocol version, tools capability + serverInfo', async () => {
  const res = await handleRpc(creator, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  const r = result(res);
  assert.equal(typeof r.protocolVersion, 'string');
  assert.ok((r.capabilities as Record<string, unknown>).tools);
  assert.equal((r.serverInfo as { name: string }).name, 'sovereign-agentic-os');
});

test('notifications/initialized: is a notification (no response)', async () => {
  const res = await handleRpc(creator, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});

test('ping: replies with an empty result', async () => {
  const res = await handleRpc(creator, { jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepEqual(result(res), {});
});

test('tools/list: role-scoped — admin sees elevated tools, a creator does NOT', async () => {
  const adminNames = listToolsForRole(admin.role).map((t) => t.name);
  const creatorNames = listToolsForRole(creator.role).map((t) => t.name);
  for (const t of ELEVATED) {
    assert.ok(adminNames.includes(t), `admin should see ${t}`);
    assert.ok(!creatorNames.includes(t), `creator must NOT see ${t}`);
  }
  // Both roles get the cross-OS read tools + a valid JSON Schema per tool.
  assert.ok(creatorNames.includes('query_data'));
  assert.ok(creatorNames.includes('science_predict'));
  const list = listToolsForRole(admin.role);
  for (const t of list) assert.equal(t.inputSchema.type, 'object');
  assert.ok(adminNames.length > creatorNames.length);
});

test('tools/list over RPC: matches the role-scoped registry', async () => {
  const res = await handleRpc(builder, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (result(res).tools as { name: string }[]).map((t) => t.name);
  assert.ok(tools.includes('promote')); // builder is elevated
  assert.ok(tools.includes('create_software'));
});

test('tools/call: routes to the governed function under the caller identity', async () => {
  // create_software delegates to the SAME governed lib the UI uses.
  const res = await handleRpc(builder, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'create_software', arguments: { name: 'MCP Client App', template: 'nextjs-supabase' } },
  });
  const r = result(res);
  assert.notEqual(r.isError, true);
  const text = (r.content as { text: string }[])[0].text;
  assert.match(text, /"id"/); // the created app came back through the governed path
});

test('tools/call: a hidden tool is refused with a JSON-RPC error (never trusts the client)', async () => {
  const res = await handleRpc(creator, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'promote', arguments: { appId: 'whatever' } },
  });
  assert.ok(res && 'error' in res);
  assert.equal((res as JsonRpcResponse).error?.code, -32602);
});

test('tools/call: a GOVERNANCE denial maps to an MCP tool error (isError), not a crash', async () => {
  // Builder creates a Personal app, promotes it to Shared (allowed), then the
  // second promote (Shared→Certified) needs an Admin → governed 403.
  const created = result(
    await handleRpc(builder, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_software', arguments: { name: 'Promote Me' } },
    }),
  );
  const appId = JSON.parse((created.content as { text: string }[])[0].text).id as string;

  const firstPromote = result(
    await handleRpc(builder, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'promote', arguments: { appId } },
    }),
  );
  assert.notEqual(firstPromote.isError, true); // Personal → Shared is allowed for a builder

  const secondPromote = result(
    await handleRpc(builder, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'promote', arguments: { appId } },
    }),
  );
  assert.equal(secondPromote.isError, true); // Shared → Certified needs an Admin
  assert.match((secondPromote.content as { text: string }[])[0].text, /Administrator|\(403\)/);
});

test('unknown method: returns JSON-RPC method-not-found', async () => {
  const res = await handleRpc(creator, { jsonrpc: '2.0', id: 8, method: 'no/such/method' });
  assert.equal((res as JsonRpcResponse).error?.code, -32601);
});

test('SIMULATED MCP CLIENT: initialize → tools/list → read-only tools/call', async () => {
  const init = result(await handleRpc(admin, { jsonrpc: '2.0', id: 'a', method: 'initialize' }));
  assert.ok(init.protocolVersion);

  const listed = result(await handleRpc(admin, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }));
  const names = (listed.tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes('query_data'));

  // A read-only governed call — query_data goes through OPA + queryRun + trace.
  const called = result(
    await handleRpc(admin, {
      jsonrpc: '2.0',
      id: 'c',
      method: 'tools/call',
      params: { name: 'query_data', arguments: { sql: 'SELECT 1' } },
    }),
  );
  // Whether OPA allows or the mart is offline, the shape is a valid MCP content
  // result (allowed → rows/trace text; denied/offline → isError text) — no crash.
  assert.ok(Array.isArray(called.content));
  assert.equal((called.content as { type: string }[])[0].type, 'text');
});

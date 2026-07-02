/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import {
  handleRpc,
  listToolsForRole,
  toolsForTab,
  MCP_TABS,
  isMcpTab,
  ALL_MCP_TOOLS,
  type JsonRpcResponse,
} from './server.ts';

const creator: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'participant' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

test('every tool is tagged with exactly one known tab', () => {
  for (const t of ALL_MCP_TOOLS) {
    assert.ok(isMcpTab(t.tab), `${t.name} has an unknown tab: ${t.tab}`);
  }
  // Every declared tab has at least one tool (no empty MCP server).
  for (const tab of MCP_TABS) {
    assert.ok(toolsForTab(tab).length > 0, `tab ${tab} has no tools`);
  }
});

test('toolsForTab returns ONLY that tab’s tools', () => {
  assert.deepEqual(
    toolsForTab('data').map((t) => t.name).sort(),
    ['query_data'],
  );
  assert.deepEqual(
    toolsForTab('science').map((t) => t.name).sort(),
    ['science_predict'],
  );
  assert.deepEqual(
    toolsForTab('knowledge').map((t) => t.name).sort(),
    ['search_knowledge'],
  );
  assert.deepEqual(
    toolsForTab('agents').map((t) => t.name).sort(),
    ['list_agent_systems'],
  );
  // Software is the platform surface — several tools, all tagged software.
  const software = toolsForTab('software').map((t) => t.name);
  assert.ok(software.includes('create_software'));
  assert.ok(software.includes('promote'));
  assert.ok(!software.includes('query_data'));
});

test('a tab MCP tools/list returns ONLY that tab’s tools, still role-scoped', async () => {
  // Software tab, creator: sees software tools but NOT elevated promote/delete.
  const res = await handleRpc(
    creator,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { tools: toolsForTab('software') },
  );
  const names = (result(res).tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes('create_software'));
  assert.ok(!names.includes('promote'), 'creator must not see elevated promote');
  assert.ok(!names.includes('query_data'), 'software MCP must not leak the data tool');

  // Same tab, builder: elevated tools become visible.
  const bres = await handleRpc(
    builder,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { tools: toolsForTab('software') },
  );
  const bnames = (result(bres).tools as { name: string }[]).map((t) => t.name);
  assert.ok(bnames.includes('promote'));
});

test('a tab MCP cannot call a tool from another tab (scoped tools/call)', async () => {
  // The Data MCP must refuse create_software even for a builder — it is out of scope.
  const res = await handleRpc(
    builder,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_software', arguments: { name: 'x' } } },
    { tools: toolsForTab('data') },
  );
  assert.ok(res && 'error' in res);
  assert.equal((res as JsonRpcResponse).error?.code, -32602);
});

test('initialize carries per-tab serverInfo + instructions when provided', async () => {
  const res = await handleRpc(
    creator,
    { jsonrpc: '2.0', id: 4, method: 'initialize' },
    { tools: toolsForTab('data'), serverInfo: { name: 'sovereign-agentic-os-data', title: 'X', version: '1' }, instructions: 'DATA CONTEXT' },
  );
  const r = result(res);
  assert.equal((r.serverInfo as { name: string }).name, 'sovereign-agentic-os-data');
  assert.equal(r.instructions, 'DATA CONTEXT');
});

test('the overarching endpoint (no tools override) still sees ALL tools', async () => {
  const res = await handleRpc(builder, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
  const names = (result(res).tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes('create_software'));
  assert.ok(names.includes('query_data'));
  assert.ok(names.includes('search_knowledge'));
  assert.ok(names.includes('list_agent_systems'));
});

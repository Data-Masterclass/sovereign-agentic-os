/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import {
  handleRpc,
  toolsForTab,
  MCP_TABS,
  isMcpTab,
  ALL_MCP_TOOLS,
  type JsonRpcResponse,
} from './server.ts';

const creator: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

test('every tool is tagged with a known tab (a real MCP tab, or `meta` for discovery)', () => {
  for (const t of ALL_MCP_TOOLS) {
    assert.ok(isMcpTab(t.tab) || t.tab === 'meta', `${t.name} has an unknown tab: ${t.tab}`);
  }
  // Every declared tab has at least one tool (no empty MCP server).
  for (const tab of MCP_TABS) {
    assert.ok(toolsForTab(tab).length > 0, `tab ${tab} has no tools`);
  }
});

test('every declared write tool is registered under its correct real tab', () => {
  const namesFor = (tab: (typeof MCP_TABS)[number]) => toolsForTab(tab).map((t) => t.name);
  // Data
  for (const n of ['create_dataset', 'add_dataset_version', 'document_dataset', 'promote_dataset', 'query_data']) {
    assert.ok(namesFor('data').includes(n), `data tab missing ${n}`);
  }
  // Knowledge
  for (const n of ['author_knowledge', 'publish_knowledge', 'index_knowledge', 'search_knowledge']) {
    assert.ok(namesFor('knowledge').includes(n), `knowledge tab missing ${n}`);
  }
  // Files / Metrics / Dashboards / Big Bets / Agents
  assert.ok(namesFor('files').includes('upload_file') && namesFor('files').includes('promote_file'));
  assert.ok(namesFor('metrics').includes('define_metric'));
  assert.ok(namesFor('dashboards').includes('create_dashboard'));
  assert.ok(namesFor('bigbets').includes('create_big_bet'));
  for (const n of ['create_agent_system', 'commit_agent_files', 'build_agent_system', 'list_agent_systems']) {
    assert.ok(namesFor('agents').includes(n), `agents tab missing ${n}`);
  }
});

test('toolsForTab: a tab view carries its own tools + the meta discovery tools, and NO other tab’s', () => {
  const data = toolsForTab('data').map((t) => t.name);
  assert.ok(data.includes('create_dataset'));
  // meta discovery tools ride along on every tab
  assert.ok(data.includes('whoami') && data.includes('list_capabilities'));
  // but never another tab's tools
  assert.ok(!data.includes('create_software'));
  assert.ok(!data.includes('author_knowledge'));
  assert.ok(!data.includes('upload_file'));

  // Software is the platform surface — several tools, all tagged software (+ meta).
  const software = toolsForTab('software').map((t) => t.name);
  assert.ok(software.includes('create_software') && software.includes('promote'));
  assert.ok(!software.includes('query_data'));
  assert.ok(software.includes('whoami'));
});

test('a tab MCP tools/list returns ONLY that tab’s tools (+ meta), still role-scoped', async () => {
  // Software tab, creator: sees software tools but NOT elevated promote/delete.
  const res = await handleRpc(
    creator,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { tools: toolsForTab('software') },
  );
  const names = (result(res).tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes('create_software'));
  assert.ok(names.includes('whoami'), 'discovery tools must be visible on every tab');
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
  for (const n of ['create_software', 'query_data', 'search_knowledge', 'list_agent_systems', 'create_dataset', 'upload_file', 'define_metric', 'create_dashboard', 'create_big_bet', 'create_agent_system', 'whoami', 'list_capabilities']) {
    assert.ok(names.includes(n), `overarching endpoint missing ${n}`);
  }
});

test('per-tab header button: every mcpTab value used in PageHeader is a valid McpTab with tools', () => {
  // These are the mcpTab prop values passed to PageHeader in each MCP-bearing tab page.
  const headerTabs = ['software', 'data', 'science', 'knowledge', 'agents', 'files', 'metrics', 'dashboards', 'bigbets'];
  for (const t of headerTabs) {
    assert.ok(isMcpTab(t), `PageHeader uses mcpTab="${t}" which is not a recognised McpTab`);
    if (isMcpTab(t)) {
      assert.ok(toolsForTab(t).length > 0, `mcpTab="${t}" maps to an empty tool set — stale`);
    }
  }
  // Exactly these tabs get the header button (no more, no less than MCP_TABS).
  assert.deepEqual([...MCP_TABS].sort(), headerTabs.sort());
});

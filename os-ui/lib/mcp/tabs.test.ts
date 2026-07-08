/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurrentUser } from '@/lib/auth';
import {
  handleRpc,
  toolsForTab,
  MCP_TABS,
  isMcpTab,
  ALL_MCP_TOOLS,
  type JsonRpcResponse,
} from './server.ts';
import { PROMPTS } from './prompts.ts';

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
  // Data (registry spine + the Wave-A physical pipeline)
  for (const n of ['create_dataset', 'add_dataset_version', 'document_dataset', 'request_promotion', 'approve_promotion', 'query_data', 'ingest_dataset', 'profile_dataset', 'transform_silver', 'build_gold_join']) {
    assert.ok(namesFor('data').includes(n), `data tab missing ${n}`);
  }
  // Knowledge
  for (const n of ['author_knowledge', 'publish_knowledge', 'index_knowledge', 'search_knowledge']) {
    assert.ok(namesFor('knowledge').includes(n), `knowledge tab missing ${n}`);
  }
  // Files / Metrics / Dashboards / Big Bets / Agents / Science
  // request_promotion/approve_promotion live on data but ALSO surface on files (extraTabs).
  assert.ok(namesFor('files').includes('upload_file') && namesFor('files').includes('request_promotion'));
  assert.ok(namesFor('files').includes('get_file'), 'files tab missing the Wave-B read-back');
  assert.ok(namesFor('metrics').includes('define_metric') && namesFor('metrics').includes('query_metric'));
  assert.ok(namesFor('metrics').includes('get_metric'), 'metrics tab missing the Wave-B read-back');
  assert.ok(namesFor('dashboards').includes('create_dashboard') && namesFor('dashboards').includes('get_dashboard'));
  for (const n of ['create_big_bet', 'list_big_bets', 'get_big_bet', 'attach_component', 'update_big_bet']) {
    assert.ok(namesFor('bigbets').includes(n), `bigbets tab missing ${n}`);
  }
  for (const n of ['read_app_files', 'get_software_status']) {
    assert.ok(namesFor('software').includes(n), `software tab missing ${n}`);
  }
  assert.ok(namesFor('connections').includes('list_connection_templates'), 'connections tab missing the template catalog');
  for (const n of ['create_agent_system', 'commit_agent_files', 'build_agent_system', 'run_agent_system', 'list_agent_systems']) {
    assert.ok(namesFor('agents').includes(n), `agents tab missing ${n}`);
  }
  for (const n of ['science_predict', 'list_models', 'get_model']) {
    assert.ok(namesFor('science').includes(n), `science tab missing ${n}`);
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

test('context.md and guide.md files reference only real MCP tool names (drift tripwire)', () => {
  // Tools AND prompts are both legitimate references — a brief may point the AI at a
  // slash-command front door (e.g. `score_and_wire_prediction`) as well as at tools.
  const realToolNames = new Set([...ALL_MCP_TOOLS.map((t) => t.name), ...PROMPTS.map((p) => p.name)]);

  // Non-tool tokens that legitimately appear in backticks in these markdown files.
  // Extend this list only for provably non-tool terms — never to paper over a dead tool.
  const NON_TOOL = new Set([
    'bad_request', 'not_found', 'forbidden', 'conflict', // typed error codes
    'not_null', 'accepted_values', 'not_blank',           // data-quality rule names
    'not_run',                                            // DQ result status (honest not-run)
    'count_distinct', 'count_distinct_approx',            // aggregation types (not tools)
    'rest_api',                                           // connection type enum value
    'gross_revenue', 'order_count',                       // example metric names in guide worked examples
  ]);

  const tabsDir = join(process.cwd(), 'lib', 'tabs');
  const guidesDir = join(tabsDir, 'guides');

  const markdownFiles: string[] = [
    ...readdirSync(tabsDir)
      .filter((f: string) => f.endsWith('.context.md'))
      .map((f: string) => join(tabsDir, f)),
    ...readdirSync(guidesDir)
      .filter((f: string) => f.endsWith('.guide.md'))
      .map((f: string) => join(guidesDir, f)),
  ];

  // Pattern 1: function-call style `tool_name(  — unambiguously a tool reference.
  const CALL_RE = /`([a-z][a-z0-9_]+)\(/g;
  // Pattern 2: standalone snake_case `name_with_underscore`  — tool-name shaped token.
  const BARE_RE = /`([a-z][a-z0-9]*_[a-z0-9_]+)`/g;

  const violations: string[] = [];

  for (const file of markdownFiles) {
    const text = readFileSync(file, 'utf8');
    const filename = file.split('/').pop()!;

    for (const m of text.matchAll(CALL_RE)) {
      const name = m[1];
      if (!realToolNames.has(name)) {
        violations.push(`${filename}: dead tool reference \`${name}(\``);
      }
    }

    for (const m of text.matchAll(BARE_RE)) {
      const name = m[1];
      if (!realToolNames.has(name) && !NON_TOOL.has(name)) {
        violations.push(`${filename}: unrecognised token \`${name}\` — add to NON_TOOL allowlist or fix the tool name`);
      }
    }
  }

  assert.deepEqual(violations, [], `Tool-name drift detected:\n${violations.join('\n')}`);
});

test('global topbar MCP button: the overarching endpoint (no tab) exposes all tools; McpDrawer tab prop is optional', () => {
  // The global "Connect your AI Tool via MCP" button lives in the top-right topbar
  // on EVERY page (via PageHeader). It uses McpDrawer with no tab prop, which
  // targets /api/mcp (no suffix) with serverName "sovereign-os" — the full surface.
  //
  // Verify: every MCP_TAB has tools (so the overarching endpoint is non-empty),
  // and the overarching ALL_MCP_TOOLS list includes the key tools from each domain.
  for (const tab of MCP_TABS) {
    assert.ok(toolsForTab(tab).length > 0, `tab ${tab} has no tools — overarching endpoint would be incomplete`);
  }
  const allNames = ALL_MCP_TOOLS.map((t) => t.name);
  for (const n of [
    'create_dataset', 'author_knowledge', 'upload_file', 'define_metric',
    'create_dashboard', 'create_big_bet', 'create_agent_system', 'create_software',
    'query_data', 'search_knowledge', 'whoami', 'list_capabilities',
  ]) {
    assert.ok(allNames.includes(n), `overarching endpoint missing tool: ${n}`);
  }
  // The global button passes no tab — 'global' is NOT a MCP_TAB entry.
  assert.ok(!MCP_TABS.includes('global' as never), '"global" must not appear in MCP_TABS — it is the overarching endpoint, not a tab');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, toolsForTab, ALL_MCP_TOOLS, type JsonRpcResponse } from './server.ts';
import { GUIDE_PATHS, loadGuide, type GuidePath } from '@/lib/tabs/guides';
import { config } from '@/lib/core/config';
import { __resetStore as resetData } from '@/lib/data/store';

/**
 * The DISCOVERY tools (thin governed adapters) + the science_predict run-as-user
 * fix + the guide↔tool-name drift guard.
 */

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

function result(res: JsonRpcResponse | null): Record<string, unknown> {
  assert.ok(res && 'result' in res, 'expected a JSON-RPC result');
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
async function callTool(user: CurrentUser, name: string, args: Record<string, unknown> = {}) {
  const r = result(await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  return { r, text: (r.content as { text: string }[])[0].text };
}

test('list_datasets: delegates to the governed store and is DLS-scoped to the caller', async () => {
  resetData();
  const created = await callTool(cara, 'create_dataset', { name: 'Cara Set' });
  const id = (JSON.parse(created.text) as { id: string }).id;

  const caraList = await callTool(cara, 'list_datasets');
  assert.match(caraList.text, new RegExp(id), 'Cara sees her dataset via list_datasets');

  const danList = await callTool(dan, 'list_datasets');
  assert.ok(!danList.text.includes(id), 'Dan (other domain) does NOT see Cara’s Personal dataset');
});

test('get_dataset: an id the caller cannot see returns a typed not_found (no leak)', async () => {
  const { r } = await callTool(cara, 'get_dataset', { datasetId: 'ds_missing' });
  assert.equal(r.isError, true);
  assert.equal((r.structuredContent as { error: { code: string } }).error.code, 'not_found');
});

test('get_guide: returns the same markdown as the guide resources for tools-only clients', async () => {
  const { text } = await callTool(cara, 'get_guide', { path: 'overview' });
  assert.ok(text.length > 200);
});

test('the discovery + connection tools are all registered on the overarching endpoint', () => {
  const names = ALL_MCP_TOOLS.map((t) => t.name);
  for (const n of [
    'list_datasets', 'get_dataset', 'list_knowledge', 'get_knowledge', 'list_files', 'search_files',
    'list_metrics', 'list_dashboards', 'list_big_bets', 'get_agent_system', 'list_software', 'get_software',
    'list_connections', 'get_connection', 'create_connection', 'test_connection', 'promote_connection', 'get_guide',
    // Wave B — operate & read-back parity.
    'get_metric', 'get_dashboard', 'get_big_bet', 'get_file', 'read_app_files', 'get_software_status', 'list_connection_templates',
  ]) assert.ok(names.includes(n), `missing discovery tool ${n}`);
});

test('connections is a real MCP tab and promote_connection is Builder-gated', () => {
  const conn = toolsForTab('connections');
  const names = conn.map((t) => t.name);
  assert.ok(names.includes('create_connection') && names.includes('test_connection'));
  const promote = conn.find((t) => t.name === 'promote_connection');
  assert.equal(promote?.minRole, 'builder', 'promote_connection is the Builder gate');
});

test('science_predict: runs AS THE CALLER (principal user:<id>), never the hardcoded sales-assistant', async () => {
  const prev = config.mlEnabled;
  (config as { mlEnabled: boolean }).mlEnabled = true;
  try {
    const { text } = await callTool(cara, 'science_predict', { account: 'acme' });
    assert.ok(!text.includes('sales-assistant'), 'the hardcoded service principal is gone');
    assert.match(text, /user:cara/, 'the predict door runs under the caller’s own principal');
  } finally {
    (config as { mlEnabled: boolean }).mlEnabled = prev;
  }
});

test('science_predict: 404 (not_found) when ml.enabled is false', async () => {
  const prev = config.mlEnabled;
  (config as { mlEnabled: boolean }).mlEnabled = false;
  try {
    const { r } = await callTool(cara, 'science_predict', {});
    assert.equal(r.isError, true);
    assert.equal((r.structuredContent as { error: { code: string } }).error.code, 'not_found');
  } finally {
    (config as { mlEnabled: boolean }).mlEnabled = prev;
  }
});

// --- Guide ↔ tool-name drift guard -------------------------------------------
// Guides legitimately CROSS-reference tools from other tabs (discover-before-
// create spans tabs; a connections guide mentions how apps consume via
// use_connection). The drift that must NEVER slip through is a guide INVOKING a
// tool that does not exist (a renamed/removed/hallucinated tool, e.g. the old
// promote_dataset). So: every backticked INVOCATION `name(...)` must resolve to
// a real registered tool. Prose tokens without parens (not_null, system.yaml)
// are ignored.
const PATH_PRIMARY: Partial<Record<GuidePath, string[]>> = {
  data: ['create_dataset', 'request_promotion', 'approve_promotion', 'ingest_dataset', 'profile_dataset', 'transform_silver', 'build_gold_join'],
  knowledge: ['author_knowledge', 'publish_knowledge'],
  connections: ['create_connection', 'promote_connection', 'list_connection_templates'],
  agents: ['create_agent_system', 'build_agent_system', 'run_agent_system'],
  software: ['create_software', 'decide_deploy', 'read_app_files', 'get_software_status'],
  metrics: ['define_metric', 'query_metric', 'get_metric'],
  dashboards: ['create_dashboard', 'get_dashboard'],
  bigbets: ['create_big_bet', 'get_big_bet', 'attach_component', 'update_big_bet'],
  files: ['upload_file', 'request_promotion', 'get_file'],
  science: ['science_predict', 'list_models', 'get_model'],
};

test('every guide invokes ONLY tools that exist, and each pathway guide names its core tools', () => {
  const allToolNames = new Set(ALL_MCP_TOOLS.map((t) => t.name));
  for (const path of GUIDE_PATHS) {
    const md = loadGuide(path);
    assert.ok(md.length > 0, `guide ${path} is present`);
    // 1. No invocation of a non-existent tool (drift guard).
    for (const raw of md.match(/`([^`]+)`/g) ?? []) {
      const token = raw.slice(1, -1);
      if (/^[a-z][a-z0-9_]*\(/.test(token)) {
        const ident = (token.match(/^[a-z][a-z0-9_]*/) ?? [''])[0];
        assert.ok(allToolNames.has(ident), `guide "${path}" invokes tool "${ident}" which does not exist`);
      }
    }
    // 2. Each pathway guide actually names its own core tools (content quality).
    for (const primary of PATH_PRIMARY[path] ?? []) {
      assert.ok(md.includes(primary), `guide "${path}" is missing its core tool "${primary}"`);
    }
  }
});

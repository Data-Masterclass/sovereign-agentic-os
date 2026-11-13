/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every DATA tool dispatches, carries a schema, and refuses a foreign object in the
 *             documented shape (engine rebuild B4, checklist X7 — the data half)
 * USER STORY: As an AI client I want every tool `list_capabilities` advertises to be callable and to
 *             answer a governance denial with a typed `{code, reason, hint}` — never `unknown tool`,
 *             never a stack trace, never a 500 — so I can act on the error instead of guessing.
 * ARCHITECTURE:
 *   - ONE table-driven test over the dispatcher (`handleRpc`), not per-tool happy paths: the tools
 *     come from `ALL_MCP_TOOLS` (what `list_capabilities` enumerates), so a tool added later is
 *     covered the moment it is registered.
 *   - The "foreign object" case uses a dataset owned by ANOTHER user in another domain; every
 *     object-taking tool must refuse it at its guard — before any SQL, commit or launch. Required
 *     arguments are filled from the schema so the refusal is the GUARD's, not the validator's.
 *   - The agents half of X7 is Part F's; this file deliberately covers the data tools only.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, ALL_MCP_TOOLS, roleCanUse, type JsonRpcResponse, type ToolError, type McpTool, type JsonSchema } from '@core/mcp/server';
import * as store from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';

/**
 * The data pathway's tools: every tool registered under the `data` tab, plus `get_lineage`, which
 * is registered under `governance` with `extraTabs: ['data', …]` and IS the data tab's lineage read.
 * `use_data` / `use_as_data` are software-tab tools (an APP consuming or snapshotting data); their
 * conformance belongs with the software/agents half of X7 (Part F), not here.
 */
const dataTools: McpTool[] = ALL_MCP_TOOLS.filter(
  (t) => t.tab === 'data' || t.extraTabs?.includes('data'),
);

const caller: CurrentUser = { id: 'zed', name: 'Zed', domains: ['ops'], role: 'creator' };
const admin: CurrentUser = { id: 'sara', name: 'Sara', domains: ['ops', 'sales'], role: 'admin' };
const FOREIGN = 'ds_foreign_private';

/** The documented error vocabulary (`structuredError` in core/mcp/server.ts). `error` is the
 *  catch-all an unexpected failure falls into — a conformant tool never answers with it. */
const DOCUMENTED = new Set(['not_found', 'forbidden', 'bad_request', 'conflict']);

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  // The flag must not matter to a REFUSAL: no commit, no launch, no repo is touched.
  __setDataProjectGitForTests(false);
  store.__seedDatasetForTest({ id: FOREIGN, name: 'Someone else’s orders', owner: 'amir', domain: 'sales' });
});

async function call(user: CurrentUser, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res, `${name}: the dispatcher answered nothing`);
  return res;
}

/** A plausible value for one schema property — ids point at the foreign/absent object. */
function filler(name: string, prop: JsonSchema, foreignId: string): unknown {
  if (/^datasetId$/.test(name)) return foreignId;
  if (/id$/i.test(name)) return `${name}_absent`;
  const type = prop.type;
  if (type === 'array') return [];
  if (type === 'number') return 1;
  if (type === 'boolean') return false;
  if (type === 'object') return { schema: 'public', table: 'events' };
  const enumValues = (prop as { enum?: string[] }).enum;
  if (enumValues?.length) return enumValues[0];
  return 'x';
}

function argsFor(tool: McpTool, foreignId: string): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = {};
  for (const name of tool.inputSchema.required ?? []) out[name] = filler(name, props[name] ?? {}, foreignId);
  // A sync save needs a real-shaped schedule and an array-typed rule list to reach the guard.
  if ('schedule' in out) out.schedule = 'daily';
  if ('rules' in out) out.rules = [{ rule: 'not_null', column: 'order_id' }];
  if ('picks' in out) out.picks = [];
  if ('columns' in out) out.columns = ['order_id'];
  if ('content' in out) out.content = 'order_id\n1';
  if ('sql' in out) out.sql = 'select 1';
  if ('kind' in out) out.kind = 'dataset';
  if ('id' in out && tool.name === 'request_promotion') out.id = foreignId;
  return out;
}

test('X7 (data): every data tool is advertised by list_capabilities and carries a usable input schema', async () => {
  assert.ok(dataTools.length >= 20, `expected the data pathway's tools, found ${dataTools.length}`);
  const res = await call(admin, 'list_capabilities', {});
  const payload = JSON.parse((((res as JsonRpcResponse).result as { content: { text: string }[] }).content[0]).text) as {
    available: { name: string }[];
    gated: { name: string }[];
  };
  const advertised = new Set([...payload.available, ...payload.gated].map((t) => t.name));
  for (const tool of dataTools) {
    assert.ok(advertised.has(tool.name), `${tool.name} is registered but not advertised by list_capabilities`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema must be an object schema`);
    assert.ok(tool.inputSchema.properties, `${tool.name}: inputSchema has no properties`);
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(
        (tool.inputSchema.properties as Record<string, unknown>)[req],
        `${tool.name}: required '${req}' is not described in properties`,
      );
    }
    assert.ok(tool.description.length > 40, `${tool.name}: no usable description`);
  }
});

test('X7 (data): every data tool DISPATCHES — the dispatcher never answers "Tool not available"', async () => {
  for (const tool of dataTools) {
    const res = await call(admin, tool.name, argsFor(tool, FOREIGN));
    assert.ok(!('error' in res && res.error), `${tool.name}: JSON-RPC error ${JSON.stringify((res as { error?: unknown }).error)}`);
  }
});

test('X7 (data): a foreign object is refused in the DOCUMENTED shape — typed, no stack, no 500', async () => {
  const objectTools = dataTools.filter((t) => (t.inputSchema.required ?? []).includes('datasetId'));
  assert.ok(objectTools.length >= 10, `expected the dataset-addressed tools, found ${objectTools.length}`);
  for (const tool of objectTools) {
    const res = await call(caller, tool.name, argsFor(tool, FOREIGN));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    assert.equal(result.isError, true, `${tool.name}: a foreign dataset must be a typed tool error`);
    const err = (result.structuredContent as { error: ToolError }).error;
    assert.ok(DOCUMENTED.has(err.code), `${tool.name}: error code '${err.code}' is outside the documented set (${[...DOCUMENTED].join('|')})`);
    assert.ok(err.code === 'not_found' || err.code === 'forbidden', `${tool.name}: a foreign object must be not_found/forbidden, got ${err.code}`);
    assert.ok(err.reason.length > 0 && !err.reason.includes('\n    at '), `${tool.name}: the reason leaks a stack trace`);
    assert.ok(err.hint.length > 0, `${tool.name}: no actionable hint`);
  }
});

test('X7 (data): a role gate answers forbidden naming the role it needs, before any work', async () => {
  for (const tool of dataTools.filter((t) => !roleCanUse('creator', t.minRole))) {
    const res = await call(caller, tool.name, argsFor(tool, FOREIGN));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    assert.equal(result.isError, true, `${tool.name}: a role gate must be a typed tool error`);
    const err = (result.structuredContent as { error: ToolError }).error;
    assert.equal(err.code, 'forbidden', `${tool.name}: a role gate is forbidden, got ${err.code}`);
    assert.match(err.reason, new RegExp(tool.minRole), `${tool.name}: the reason must name the role required`);
  }
});

test('X7 (data): a refusal writes nothing — the foreign dataset is untouched', async () => {
  const before = JSON.stringify(store.listAllDatasets());
  for (const tool of dataTools.filter((t) => (t.inputSchema.required ?? []).includes('datasetId'))) {
    await call(caller, tool.name, argsFor(tool, FOREIGN));
  }
  assert.equal(JSON.stringify(store.listAllDatasets()), before, 'a refused call mutated the store');
});

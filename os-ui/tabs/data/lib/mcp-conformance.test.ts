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
 *   - The code is asserted PER TOOL, not as "one of two" (review M-5): an EXISTING dataset the
 *     caller may not view is `forbidden` and a dataset that does not exist is `not_found`. That is
 *     what `store.getDataset` does and what deviation B4-11 recorded; an either-or assertion would
 *     pass while a tool leaked existence by answering `not_found` for a private object.
 *   - Both refusal tests run with `DATA_PROJECT_GIT` OFF **and ON**, with a commit hook installed
 *     and recording: a refusal must commit nothing in either world.
 *   - The agents half of X7 is Part F's; this file deliberately covers the data tools only.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, ALL_MCP_TOOLS, roleCanUse, type JsonRpcResponse, type ToolError, type McpTool, type JsonSchema } from '@core/mcp/server';
import * as store from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { __setDataProjectGitForTests, installDataProjectCommitHook, awaitDataProjectCommits } from '@tabs/data/lib/dbt/commit';

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

/** The typed error of a call that must be refused. */
async function refusal(user: CurrentUser, name: string, args: Record<string, unknown>): Promise<ToolError> {
  const res = await call(user, name, args);
  const result = (res as JsonRpcResponse).result as Record<string, unknown>;
  assert.equal(result.isError, true, `${name}: this call must be a typed tool error`);
  const err = (result.structuredContent as { error: ToolError }).error;
  assert.ok(DOCUMENTED.has(err.code), `${name}: error code '${err.code}' is outside the documented set (${[...DOCUMENTED].join('|')})`);
  assert.ok(err.reason.length > 0 && !err.reason.includes('\n    at '), `${name}: the reason leaks a stack trace`);
  assert.ok(err.hint.length > 0, `${name}: no actionable hint`);
  return err;
}

for (const flagOn of [false, true]) {
  test(`X7 (data): an EXISTING invisible dataset is \`forbidden\` and a MISSING one is \`not_found\`, per tool (flag ${flagOn ? 'on' : 'off'}) (review M-5)`, async () => {
    __setDataProjectGitForTests(flagOn);
    const commits: string[] = [];
    const uninstall = installDataProjectCommitHook({
      committer: async (domain, _files, opts) => {
        commits.push(`${domain}: ${opts.message.split('\n')[0]}`);
        return { sha: 'f'.repeat(40), changed: true };
      },
    });
    try {
      const objectTools = dataTools.filter((t) => (t.inputSchema.required ?? []).includes('datasetId'));
      assert.ok(objectTools.length >= 10, `expected the dataset-addressed tools, found ${objectTools.length}`);
      for (const tool of objectTools) {
        // (a) It EXISTS and the caller may not view it ⇒ forbidden. Exactly 403-semantics, which
        // is what the store does on every surface in the OS (deviation B4-11).
        const invisible = await refusal(caller, tool.name, argsFor(tool, FOREIGN));
        assert.equal(invisible.code, 'forbidden', `${tool.name}: an EXISTING invisible dataset must be forbidden, got ${invisible.code}`);
        // (b) It does not exist at all ⇒ not_found.
        const missing = await refusal(caller, tool.name, argsFor(tool, 'ds_does_not_exist'));
        assert.equal(missing.code, 'not_found', `${tool.name}: a dataset that does not exist must be not_found, got ${missing.code}`);
      }
      await awaitDataProjectCommits();
      assert.deepEqual(commits, [], `a refusal committed: ${commits.join(' | ')}`);
    } finally {
      uninstall();
      __setDataProjectGitForTests(false);
    }
  });
}

test('X7 (data): `get_dagster_run` hides a RUN the way agent runs are hidden — foreign and ghost are the same not_found (D17)', async () => {
  // The dataset convention above (`forbidden` for an existing invisible dataset) does NOT apply
  // here, and deliberately: the addressed object is the RUN, not the dataset. A run id is handed
  // out by a build, so a `forbidden` on a foreign one would let a client sweep run ids and learn
  // which builds other domains are running. Both answers must be identical.
  const tool = ALL_MCP_TOOLS.find((t) => t.name === 'get_dagster_run');
  assert.ok(tool, 'get_dagster_run must be registered — D17 is the run-addressed read');
  assert.equal(tool!.tab, 'data');
  assert.equal(tool!.minRole, 'creator', 'reading your own build is not an elevated act');
  assert.deepEqual(tool!.inputSchema.required, ['runId']);

  // `FOREIGN` is another user's dataset in another domain; record a run on it, unscoped.
  store.setVersionRun(FOREIGN, 'silver', { commit: 'a'.repeat(40), dagsterRunId: 'run_foreign' });
  const foreign = await refusal(caller, 'get_dagster_run', { runId: 'run_foreign' });
  const ghost = await refusal(caller, 'get_dagster_run', { runId: 'run_never_minted' });
  assert.equal(foreign.code, 'not_found', `a run on a dataset you cannot see must be not_found, got ${foreign.code}`);
  assert.equal(ghost.code, 'not_found');
  assert.equal(foreign.reason, ghost.reason, 'the two refusals must be byte-identical or the id leaks');
  assert.ok(!/orders|amir|sales|ds_foreign/i.test(foreign.reason), 'the refusal named the anchor dataset');
});

test('X7 (data): a FOREIGN connection is refused on the tool that actually takes one, and commits nothing (review M-5)', async () => {
  // The review asked for `create_dataset` with a foreign `connectionId`. `create_dataset` takes
  // NO connection (`{name, domain, columns}` — an extra argument is ignored), so there is no such
  // door; the tool that names a connection is `set_dataset_sync`, and B4-4 made it refuse one the
  // caller cannot read instead of swallowing the resolver's 403. That is what is asserted here.
  store.__seedDatasetForTest({ id: 'ds_own', name: 'Mine', owner: caller.id, domain: 'ops' });
  const before = JSON.stringify(store.listAllDatasets());
  const commits: string[] = [];
  __setDataProjectGitForTests(true);
  const uninstall = installDataProjectCommitHook({
    committer: async (domain, _files, opts) => {
      commits.push(`${domain}: ${opts.message.split('\n')[0]}`);
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
  try {
    const err = await refusal(caller, 'set_dataset_sync', {
      datasetId: 'ds_own',
      connectionId: 'conn_someone_elses',
      source: { schema: 'public', table: 'events' },
      mode: 'full-refresh',
      schedule: 'daily',
    });
    assert.ok(['forbidden', 'not_found', 'bad_request'].includes(err.code), `unexpected code ${err.code}`);
    await awaitDataProjectCommits();
    assert.deepEqual(commits, [], `a refused sync save committed: ${commits.join(' | ')}`);
    assert.equal(JSON.stringify(store.listAllDatasets()), before, 'a refused sync save mutated the store');
  } finally {
    uninstall();
    __setDataProjectGitForTests(false);
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

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { parseSystem, type System } from '../system-schema.ts';
import { handleRpc as realHandleRpc } from '@/lib/mcp/server';
import {
  OS_TOOL_ALIASES,
  resolveAlias,
  resolveGrantedTools,
  isAgenticOsTeam,
  grantedToolSpecs,
  grantedToolExecutor,
  type OsToolDeps,
} from './os-tools.ts';

// --- fixtures ----------------------------------------------------------------

function sysWith(tools: string[], runtime: 'langgraph' | 'hermes' = 'langgraph'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime,
    entrypoint: 'a',
    grants: { tools },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

const CREATOR: CurrentUser = { id: 'u1', name: 'Cara Creator', domains: ['sales'], role: 'creator' };
const BUILDER: CurrentUser = { id: 'u2', name: 'Bo Builder', domains: ['sales'], role: 'builder' };
const DOMAIN_ADMIN: CurrentUser = { id: 'u3', name: 'Dana Domain-Admin', domains: ['sales'], role: 'domain_admin' };

/**
 * A deps bundle with spies. There is NO authorize spy: Gate 1b is now derived
 * IN-PROCESS from the system's resolved grant-set + the write-tool catalog, so a
 * granted READ tool must be allowed WITHOUT any injected/OPA decision. handleRpc
 * echoes the resolved tool name; enqueue records held writes.
 */
function spyDeps(over: Partial<OsToolDeps> = {}): OsToolDeps & {
  calls: { handleRpc: unknown[]; enqueue: unknown[] };
} {
  const calls = { handleRpc: [] as unknown[], enqueue: [] as unknown[] };
  const base: OsToolDeps = {
    enqueue: ((input: unknown) => {
      calls.enqueue.push(input);
      return {} as never;
    }) as OsToolDeps['enqueue'],
    handleRpc: (async (user, req) => {
      calls.handleRpc.push({ user, req });
      const name = (req.params as { name?: string })?.name;
      return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `ran ${name}` }] } };
    }) as OsToolDeps['handleRpc'],
    trace: (async () => ({}) as never) as OsToolDeps['trace'],
  };
  return Object.assign({ ...base, ...over }, { calls });
}

// --- alias resolution --------------------------------------------------------

test('alias map resolves legacy names to MCP names', () => {
  assert.equal(resolveAlias('retrieve'), 'search_knowledge');
  assert.equal(resolveAlias('metrics'), 'list_metrics');
  assert.equal(resolveAlias('files_retrieve'), 'search_files');
  assert.equal(resolveAlias('predict'), 'science_predict');
  assert.equal(resolveAlias('write_file'), 'upload_file');
  // A native MCP name passes through unchanged.
  assert.equal(resolveAlias('query_data'), 'query_data');
  // Every alias target is a real MCP tool.
  for (const target of Object.values(OS_TOOL_ALIASES)) {
    assert.ok(resolveGrantedTools(sysWith([target])).mcpNames.includes(target), `${target} is a real MCP tool`);
  }
});

test('resolveGrantedTools maps legacy grants and flags unmapped, deduped', () => {
  const r = resolveGrantedTools(sysWith(['retrieve', 'metrics', 'query_data', 'retrieve', 'web_fetch']));
  // deduped, order-preserved, then discovery companions appended (search_knowledge→
  // list_knowledge; query_data→list_datasets/get_dataset/profile_dataset).
  assert.deepEqual(r.mcpNames, [
    'search_knowledge',
    'list_metrics',
    'query_data',
    'list_knowledge',
    'list_datasets',
    'get_dataset',
    'profile_dataset',
  ]);
  assert.deepEqual(r.unmapped, ['web_fetch']);
});

// --- discovery companions (#97: discover, don't guess) -----------------------

test('resolveGrantedTools auto-grants discovery companions for a data/query tool', () => {
  const r = resolveGrantedTools(sysWith(['query_data']));
  for (const companion of ['list_datasets', 'get_dataset', 'profile_dataset']) {
    assert.ok(r.mcpNames.includes(companion), `query_data auto-grants ${companion}`);
  }
});

test('resolveGrantedTools auto-grants list_knowledge with search_knowledge and file discovery with a file read', () => {
  assert.ok(resolveGrantedTools(sysWith(['search_knowledge'])).mcpNames.includes('list_knowledge'));
  const files = resolveGrantedTools(sysWith(['get_file'])).mcpNames;
  assert.ok(files.includes('list_files') && files.includes('search_files'));
});

test('discovery companions are grant-scoped: an agent with no action tool gets no companions', () => {
  // Granting ONLY list_datasets (a discovery tool) pulls in nothing extra — the
  // expansion never introduces a tool not earned by an already-granted action tool.
  assert.deepEqual(resolveGrantedTools(sysWith(['list_datasets'])).mcpNames, ['list_datasets']);
});

// --- isAgenticOsTeam ---------------------------------------------------------

test('isAgenticOsTeam: mapped langgraph grants true; hermes/unmapped/empty false', () => {
  assert.equal(isAgenticOsTeam(sysWith(['create_software', 'commit'])), true); // software-only subset
  assert.equal(isAgenticOsTeam(sysWith(['query_data', 'search_knowledge', 'create_dataset'])), true); // mixed
  assert.equal(isAgenticOsTeam(sysWith(['retrieve', 'metrics'])), true); // legacy but fully mappable
  assert.equal(isAgenticOsTeam(sysWith(['query_data', 'web_fetch'])), false); // an unmapped tool
  assert.equal(isAgenticOsTeam(sysWith([])), false); // no grants
  assert.equal(isAgenticOsTeam(sysWith(['query_data'], 'hermes')), false); // hermes runtime
});

// --- grantedToolSpecs (role scope + node narrowing) --------------------------

test('grantedToolSpecs role-scopes and narrows to node tools', () => {
  const sys = sysWith(['query_data', 'search_knowledge', 'approve_promotion']);
  const creatorSpecs = grantedToolSpecs(CREATOR, sys).map((s) => s.name);
  assert.ok(creatorSpecs.includes('query_data'));
  assert.ok(creatorSpecs.includes('search_knowledge'));
  // approve_promotion is now a domain_admin-floor tool (approving Personal→Shared
  // needs domain_admin+) → neither a creator NOR a plain builder can SEE it.
  assert.ok(!creatorSpecs.includes('approve_promotion'));
  assert.ok(!grantedToolSpecs(BUILDER, sys).map((s) => s.name).includes('approve_promotion'));
  // A domain_admin sees it.
  assert.ok(grantedToolSpecs(DOMAIN_ADMIN, sys).map((s) => s.name).includes('approve_promotion'));
  // Node narrowing (alias-resolved) keeps the node's own tools + their discovery
  // companions (search_knowledge → list_knowledge).
  const narrowed = grantedToolSpecs(CREATOR, sys, ['retrieve']).map((s) => s.name);
  assert.deepEqual(narrowed, ['search_knowledge', 'list_knowledge']);
});

test('grantedToolSpecs: a node granted query_data also sees the discovery companions', () => {
  const sys = sysWith(['query_data']);
  const specs = grantedToolSpecs(CREATOR, sys, ['query_data']).map((s) => s.name);
  assert.ok(specs.includes('query_data'));
  for (const companion of ['list_datasets', 'get_dataset', 'profile_dataset']) {
    assert.ok(specs.includes(companion), `node sees ${companion}`);
  }
});

// --- executor: the double gate ----------------------------------------------

test('executor: an ungranted tool never executes (no OPA, no dispatch)', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWith(['search_knowledge']), 'sys1', deps);
  const res = await exec('query_data', { sql: 'select 1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Tool not available/);
  assert.equal(deps.calls.handleRpc.length, 0); // never executed
});

test('executor: a requires_approval tool enqueues and never executes', async () => {
  // `create_dataset` is a WRITE tool → Gate 1b HOLDS it in-process (write-tool
  // catalog), enqueues to Governance and never dispatches — no OPA doc needed.
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWith(['create_dataset']), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.text, /requires approval/);
  assert.equal(deps.calls.enqueue.length, 1); // enqueued to Governance
  assert.equal(deps.calls.handleRpc.length, 0); // NEVER executed
  const item = deps.calls.enqueue[0] as { tool: string; requestedBy: string; agent: string };
  assert.equal(item.tool, 'create_dataset');
  assert.equal(item.requestedBy, 'u1'); // human-in-the-loop attribution
  assert.equal(item.agent, 'os-sys1'); // the system principal
});

test('executor: an allowed tool dispatches as the ACTING USER (not the service principal)', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWith(['retrieve']), 'sys1', deps);
  const res = await exec('retrieve', { query: 'contracts' }); // legacy alias
  assert.equal(res.isError, false);
  assert.equal(res.text, 'ran search_knowledge'); // alias resolved before dispatch
  // Gate 1b is derived in-process from the granted read set — no OPA pre-gate call.
  // The governed dispatch threads the ACTING USER, never the `os-sys1` principal.
  const call = deps.calls.handleRpc[0] as { user: CurrentUser; req: { params: { name: string } } };
  assert.equal(call.user, CREATOR); // same object → identity threaded through
  assert.equal(call.user.id, 'u1');
  assert.equal(call.req.params.name, 'search_knowledge');
});

test('executor: a creator hits a typed forbidden on a builder-floor tool (real role floor)', async () => {
  // `get_policy_view` is a builder-floor READ tool: it passes Gate 1 (granted) and
  // Gate 1b (not a write hold), so it reaches the REAL handleRpc — whose role floor
  // (Gate 2) rejects a creator calling a builder-floor tool. The second gate is the
  // real authority and can't be bypassed by the in-process grant scope.
  const deps = spyDeps({ handleRpc: realHandleRpc });
  const exec = grantedToolExecutor(CREATOR, sysWith(['get_policy_view']), 'sys1', deps);
  const res = await exec('get_policy_view', { id: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.text, /requires builder|forbidden/i);
});

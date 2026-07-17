/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { parseSystem, serializeSystem, type System } from '../system-schema.ts';
import { handleRpc as realHandleRpc } from '@/lib/mcp/server';
import {
  OS_TOOL_ALIASES,
  resolveAlias,
  resolveGrantedTools,
  isAgenticOsTeam,
  grantedToolSpecs,
  grantedToolExecutor,
  grantedLayerFor,
  resolveFolderGrants,
  type ScopedItemsLoader,
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

/** Same fixture with an explicit safety preset (default parse is read-only). */
function sysWithPreset(tools: string[], preset: 'read-only' | 'read-propose' | 'read-bounded' | 'full-in-scope'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools },
    safety_preset: preset,
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

test('executor: full-in-scope runs a write directly as the acting user (no hold)', async () => {
  // The blocker fix: under full-in-scope the write tool is NOT held — it dispatches
  // through handleRpc as the acting user (gate 2 is the real authority), so a leader's
  // agent can create a new dataset/file without a Governance round-trip.
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['create_dataset'], 'full-in-scope'), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.equal(deps.calls.enqueue.length, 0); // NOT held
  assert.equal(deps.calls.handleRpc.length, 1); // ran as the acting user
  assert.equal((deps.calls.handleRpc[0] as { user: CurrentUser }).user, CREATOR);
  assert.equal(res.text, 'ran create_dataset');
});

test('executor: read-bounded runs upload_file directly (no hold)', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['upload_file'], 'read-bounded'), 'sys1', deps);
  await exec('upload_file', { name: 'report.md' });
  assert.equal(deps.calls.enqueue.length, 0);
  assert.equal(deps.calls.handleRpc.length, 1);
});

test('executor: read-propose still HOLDS a write for approval', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['create_dataset'], 'read-propose'), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.match(res.text, /requires approval/);
  assert.equal(deps.calls.enqueue.length, 1);
  assert.equal(deps.calls.handleRpc.length, 0);
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

test('executor: a granted data read (get_dataset) is AUTHORIZED for the run — dispatched as the user, not denied', async () => {
  // The reported runtime data-plane deny root cause: a granted dataset must be
  // authorized for the agent's run. The agent path authorizes a data READ under the
  // ACTING USER (Gate 2 = handleRpc(user) → OPA `query` + DLS canView), never a
  // service principal — so a runner who can see the dataset is ALLOWED, not denied.
  // This asserts the read reaches the governed door (allow), threading `user:<id>`.
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWith(['query_data']), 'sys1', deps); // query_data auto-grants get_dataset
  const res = await exec('get_dataset', { datasetId: 'ds_granted' });
  assert.equal(res.isError, false, 'a granted data read is NOT denied at the agent gate');
  assert.equal(deps.calls.handleRpc.length, 1, 'it reaches the governed dispatch (authorized for the run)');
  const call = deps.calls.handleRpc[0] as { user: CurrentUser; req: { params: { name: string; arguments: { datasetId: string } } } };
  assert.equal(call.user.id, 'u1', 'authorized under the ACTING USER (user:<id>), never os-sys1');
  assert.equal(call.req.params.name, 'get_dataset');
  assert.equal(call.req.params.arguments.datasetId, 'ds_granted', 'the granted dataset id is the one the tool resolves');
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

// --- DATA-grant medallion layer injection ---------------------------------------

/** A system granting query_data + a data product read at a specific medallion layer. */
function sysWithDataLayer(layer?: 'bronze' | 'silver' | 'gold'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: {
      tools: ['query_data'], // pulls in the get_dataset / profile_dataset companions
      data: [{ id: 'ds_orders', capability: 'Read', ...(layer ? { layer } : {}) }],
    },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

test('grantedLayerFor reads the layer of a data grant (undefined = gold/unset)', () => {
  assert.equal(grantedLayerFor(sysWithDataLayer('silver'), 'ds_orders'), 'silver');
  assert.equal(grantedLayerFor(sysWithDataLayer(), 'ds_orders'), undefined);
  assert.equal(grantedLayerFor(sysWithDataLayer('silver'), 'ds_missing'), undefined);
});

test('executor injects the granted silver layer into get_dataset args', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataLayer('silver'), 'sys1', deps);
  await exec('get_dataset', { datasetId: 'ds_orders' });
  const call = deps.calls.handleRpc[0] as { req: { params: { arguments: Record<string, unknown> } } };
  // The system.yaml layer choice is threaded into the discovery call, server-side.
  assert.equal(call.req.params.arguments.layer, 'silver');
  assert.equal(call.req.params.arguments.datasetId, 'ds_orders');
});

test('a gold/unset grant injects no layer (backward-compatible serving default)', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataLayer(), 'sys1', deps);
  await exec('get_dataset', { datasetId: 'ds_orders' });
  const call = deps.calls.handleRpc[0] as { req: { params: { arguments: Record<string, unknown> } } };
  assert.equal(call.req.params.arguments.layer, undefined);
});

test('an explicit layer arg from the agent is NOT overridden by the grant', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataLayer('silver'), 'sys1', deps);
  await exec('profile_dataset', { datasetId: 'ds_orders', layer: 'bronze' });
  const call = deps.calls.handleRpc[0] as { req: { params: { arguments: Record<string, unknown> } } };
  assert.equal(call.req.params.arguments.layer, 'bronze', 'agent-supplied layer wins');
});

// ── Wave 3: folder-grant resolution ─────────────────────────────────────────

/** A system with one Read folder grant on data (personal /contracts). */
function sysWithFolderGrant(): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: {
      tools: ['query_data'],
      data: [
        { id: 'ds_explicit', capability: 'Read' },
        { folder: { path: '/contracts', scope: 'personal' }, capability: 'Read' },
      ],
    },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

test('resolveFolderGrants materialises ONLY items under the folder from the SCOPED list (subset invariant)', async () => {
  const scoped = [
    { id: 'ds_a', folder: '/contracts' },
    { id: 'ds_b', folder: '/contracts/2024' }, // subfolder counts
    { id: 'ds_c', folder: '/other' },          // NOT under the folder
  ];
  const load: ScopedItemsLoader = async (kind, scope) => {
    assert.equal(kind, 'data');
    assert.equal(scope, 'personal');
    return scoped;
  };
  const { system, resolutions } = await resolveFolderGrants(sysWithFolderGrant(), load);
  const ids = new Set(system.grants.data.filter((g) => !g.folder).map((g) => g.id));
  // Resolved set ⊆ owner's grantable (scoped) set — never widened.
  assert.ok([...ids].every((id) => id === 'ds_explicit' || scoped.some((s) => s.id === id)));
  assert.ok(ids.has('ds_a') && ids.has('ds_b'), 'items under the folder are materialised');
  assert.ok(!ids.has('ds_c'), 'an item OUTSIDE the folder is never granted');
  assert.ok(ids.has('ds_explicit'), 'the pre-existing explicit item grant is preserved');
  // The folder grant itself is LEFT in place so the next run re-resolves it.
  assert.ok(system.grants.data.some((g) => g.folder), 'folder grant retained for late-binding');
  assert.equal(resolutions[0].ids.length, 2);
  assert.equal(resolutions[0].total, 2);
});

test('resolveFolderGrants caps at the folder-grant budget (records M of P)', async () => {
  const scoped = Array.from({ length: 10 }, (_, i) => ({ id: `ds_${i}`, folder: '/contracts' }));
  const load: ScopedItemsLoader = async () => scoped;
  const { system, resolutions } = await resolveFolderGrants(sysWithFolderGrant(), load, 3);
  const materialised = system.grants.data.filter((g) => !g.folder && g.id !== 'ds_explicit');
  assert.equal(materialised.length, 3, 'capped to the budget');
  assert.equal(resolutions[0].ids.length, 3); // M
  assert.equal(resolutions[0].total, 10);     // P
  assert.equal(resolutions[0].capped, true);
});

test('resolveFolderGrants is LATE-BINDING: an item added under the folder resolves next run', async () => {
  const before = [{ id: 'ds_a', folder: '/contracts' }];
  const after = [...before, { id: 'ds_new', folder: '/contracts' }];
  const first = await resolveFolderGrants(sysWithFolderGrant(), async () => before);
  assert.ok(!first.system.grants.data.some((g) => g.id === 'ds_new'));
  // Re-resolve the ORIGINAL system against the now-larger live list — no re-save needed.
  const second = await resolveFolderGrants(sysWithFolderGrant(), async () => after);
  assert.ok(second.system.grants.data.some((g) => g.id === 'ds_new'), 'newly-added item picked up');
});

test('resolveFolderGrants is pure (input system untouched)', async () => {
  const sys = sysWithFolderGrant();
  const before = serializeSystem(sys);
  await resolveFolderGrants(sys, async () => [{ id: 'ds_a', folder: '/contracts' }]);
  assert.equal(serializeSystem(sys), before);
});

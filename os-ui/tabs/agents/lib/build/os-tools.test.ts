/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { handleRpc as realHandleRpc } from '@core/mcp/server';
import { setDeprecationSink } from '@core/mcp/deprecated-aliases';
import { toolsForGrant } from '@tabs/agents/lib/capability-tools';
import { isWriteTool } from '@tabs/agents/lib/build/hold';
import { agentForbiddenReason } from '@core/mcp/write-tool-meta';
import {
  OS_TOOL_ALIASES,
  resolveAlias,
  resolveGrantedTools,
  unmappedGrantNames,
  grantedToolSpecs,
  grantedToolBrief,
  grantedToolExecutor,
  grantedLayerFor,
  resolveFolderGrants,
  writeTargetScope,
  holdDecision,
  holdDecisionFor,
  holdReason,
  summarizeWriteOutcomes,
  writeOutcomesLine,
  type ScopedItemsLoader,
  type OsToolDeps,
} from '@tabs/agents/lib/build/os-tools';

// --- fixtures ----------------------------------------------------------------

function sysWith(tools: string[], runtime = 'langgraph'): System {
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
/** An admin runner, so a role floor can never be what hides `reindex_corpus` in the H1 tests. */
const ADMIN_USER: CurrentUser = { id: 'u_admin', name: 'Ada Admin', domains: ['sales'], role: 'admin' };

// --- grantedToolBrief: the prompt-side manifest = the granted tools only ---------

test('grantedToolBrief: ADVERTISES only granted tools as callable list entries', () => {
  const brief = grantedToolBrief(CREATOR, sysWith(['query_data', 'search_knowledge']));
  // The advertised, callable tools are the "- <name> — …" list entries.
  const advertised = new Set(
    brief.split('\n').map((l) => /^- (\w+) —/.exec(l)?.[1]).filter((n): n is string => !!n),
  );
  assert.ok(advertised.has('query_data'));
  assert.ok(advertised.has('search_knowledge'));
  // The exact ungranted tools the live bug attempted must NOT be advertised as callable
  // (they may still be *named* inside a granted tool's own before/after hint prose, but
  // that is not a callable entry — the manifest still excludes them).
  for (const leak of ['create_software', 'build_gold_join', 'run_quality_checks', 'index_workflow']) {
    assert.ok(!advertised.has(leak), `${leak} is not granted — it must not be advertised as callable`);
  }
});

test('grantedToolBrief: the brief is a SUBSET of the advertised tool manifest', () => {
  const sys = sysWith(['query_data', 'search_knowledge']);
  const advertised = new Set(grantedToolSpecs(CREATOR, sys).map((s) => s.name));
  const brief = grantedToolBrief(CREATOR, sys);
  // Every "- name — desc" line names a tool that is genuinely in the manifest.
  for (const line of brief.split('\n')) {
    const m = /^- (\w+) —/.exec(line);
    if (m) assert.ok(advertised.has(m[1]), `${m[1]} named in brief but not advertised in manifest`);
  }
});

test('grantedToolBrief: fails closed for an empty grant set (advertise none, not all)', () => {
  const brief = grantedToolBrief(CREATOR, sysWith([]));
  assert.match(brief, /been granted NO tools/);
  assert.doesNotMatch(brief, /create_software|query_data/);
});
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

// --- unmappedGrantNames (A5: what replaced the isAgenticOsTeam boolean) ------

test('unmappedGrantNames: names the grants with no governed tool behind them, and nothing else', () => {
  assert.deepEqual(unmappedGrantNames(sysWith(['create_software', 'commit'])), []); // software-only subset
  assert.deepEqual(unmappedGrantNames(sysWith(['query_data', 'search_knowledge', 'create_dataset'])), []); // mixed
  assert.deepEqual(unmappedGrantNames(sysWith(['retrieve', 'metrics'])), []); // legacy but fully mappable
  assert.deepEqual(unmappedGrantNames(sysWith(['query_data', 'web_fetch'])), ['web_fetch']); // named, so the error can say it
  // A5 behaviour change, deliberate: a system with NO tool grants is RUNNABLE (its agents are
  // plain completions). The old boolean refused it only because the Python-runtime fallback
  // existed to catch it.
  assert.deepEqual(unmappedGrantNames(sysWith([])), []);
  // A5: `runtime: hermes` in a stored file is normalised to `langgraph` on parse — a retired
  // engine name must not make a saved system un-runnable.
  assert.equal(sysWith(['query_data'], 'hermes').runtime, 'langgraph');
  assert.deepEqual(unmappedGrantNames(sysWith(['query_data'], 'hermes')), []);
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

test('executor: a requires_approval tool under read-only enqueues and never executes', async () => {
  // Default preset is read-only, which blocks EVERY write → Gate 1b HOLDS create_dataset
  // in-process (write-tool catalog), enqueues to Governance and never dispatches. (Under
  // a non-read-only preset a PERSONAL create is NOT held — see the scope-aware tests.)
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWith(['create_dataset']), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.text, /requires .* approval/);
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

test('executor: read-propose does NOT hold a PERSONAL create (scope-aware) — runs run-as-user', async () => {
  // SCOPE-AWARE FIX: a My-lane create (create_dataset) is what the runner could do by
  // hand with no approval, so under read-propose it is NOT held — it dispatches as the
  // acting user (gate 2 = OPA/DLS/ownership is the authority). Only read-only blocks it.
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['create_dataset'], 'read-propose'), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.equal(deps.calls.enqueue.length, 0); // NOT held
  assert.equal(deps.calls.handleRpc.length, 1); // ran as the acting user
  assert.equal((deps.calls.handleRpc[0] as { user: CurrentUser }).user, CREATOR);
  assert.equal(res.text, 'ran create_dataset');
});

test('executor: read-only STILL blocks every write (personal create included)', async () => {
  // read-only is the one preset that blocks all writes regardless of target scope.
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['create_dataset'], 'read-only'), 'sys1', deps);
  const res = await exec('create_dataset', { name: 'x' });
  assert.match(res.text, /requires .* approval/);
  assert.equal(deps.calls.enqueue.length, 1);
  assert.equal(deps.calls.handleRpc.length, 0);
});

// --- SCOPE-AWARE hold: personal creates run, Domain/Company escalations held -----

test('writeTargetScope: create/author/upload/build/define = personal; escalation = domain/company', () => {
  // Personal (My) create/author/upload/build path — the runner's own work.
  for (const t of ['create_dataset', 'ingest_dataset', 'upload_file', 'author_workflow', 'define_metric', 'create_connection', 'create_software', 'create_dashboard', 'create_agent_system', 'transform_silver', 'build_gold_join', 'document_dataset']) {
    assert.equal(writeTargetScope(t), 'personal', `${t} targets personal`);
  }
  // Escalation family → Domain.
  for (const t of ['publish_workflow', 'request_promotion', 'approve_promotion']) {
    assert.equal(writeTargetScope(t), 'domain', `${t} escalates to domain`);
  }
  // Tenant-wide family → COMPANY (the admin gate). `reindex_corpus` re-parses and re-embeds a
  // whole corpus; defaulting it to `personal` made it the one write in the catalog a non-read-only
  // agent could fire at an entire tenant with no human in the loop (review H1).
  assert.equal(writeTargetScope('reindex_corpus'), 'company', 'a tenant-wide re-index is company scope');
});

test('H1: reindex_corpus is HELD to a platform admin under EVERY preset — never personal', () => {
  // The `commit` posture lesson, one rung up: being in WRITE_TOOL_TABS makes a tool visible to
  // the hold gate, not held by it. The scope is what decides, so it is pinned per preset here.
  for (const preset of ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const) {
    const d = holdDecision(preset, 'reindex_corpus');
    assert.equal(d.held, true, `${preset} must hold reindex_corpus`);
    assert.equal(d.held && d.approverRole, 'admin', `${preset} must route it to a platform admin`);
  }
  // And it is a write at all — an unclassified write answers "not held" for every preset.
  assert.equal(isWriteTool('reindex_corpus'), true);
});

test('H1: an agent run may not call reindex_corpus AT ALL — refused with the catalog’s reason', async () => {
  const deps = spyDeps();
  // Granted in the system.yaml AND under the most permissive preset: the refusal is not a grant
  // or preset accident, it is the door saying this is not an agent action.
  const exec = grantedToolExecutor(CREATOR, sysWithPreset(['reindex_corpus'], 'full-in-scope'), 'sys1', deps);
  const res = await exec('reindex_corpus', { target: 'files', mode: 'run', filter: 'all' });
  assert.equal(res.isError, true);
  const err = JSON.parse(res.text) as { error: { code: string; reason: string } };
  assert.equal(err.error.code, 'forbidden');
  assert.match(err.error.reason, /operator act, not an agent action/);
  assert.match(err.error.reason, /Platform → Re-index/);
  assert.equal(deps.calls.handleRpc.length, 0, 'never dispatched');
  assert.equal(deps.calls.enqueue.length, 0, 'and not even enqueued — this is a refusal, not a hold');
});

test('H1: reindex_corpus is never ADVERTISED to a model, even when a system grants it', () => {
  const sys = sysWithPreset(['reindex_corpus', 'search_knowledge'], 'full-in-scope');
  const specs = grantedToolSpecs(ADMIN_USER, sys).map((t) => t.name);
  assert.ok(!specs.includes('reindex_corpus'), 'a schema the gate will refuse must not be offered');
  assert.ok(specs.includes('search_knowledge'), 'the rest of the grant is untouched');
});

// --- 2026-11-19: the last eleven platform writes, classified (owner's decision) --------------
//
// Until now `decide_deploy`, `promote`, `delete`, `archive`, `request_deploy`, `create_software`,
// `use_connection`, `use_data`, `use_knowledge`, `use_as_data` and `start_preview` were declared
// `write: true` on the platform-MCP surface and ABSENT from the hold table, so
// `holdDecisionFor(preset, name)` answered "not a write" under every preset — `read-only`
// included. Three postures, one test each, plus the refusal at the door.

const ALL_PRESETS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;

/** Approvals are a HUMAN's decision: four-eyes has to mean two people, never a person and their agent. */
const PLATFORM_APPROVALS = ['decide_deploy', 'promote'] as const;
/** …and the same principle outside the software tab (review H2): deciding ANY queued request, and
 *  the domain admin's approval of a connection's My → Domain step. */
const HUMAN_ONLY_APPROVALS = [...PLATFORM_APPROVALS, 'decide_approval', 'promote_connection'] as const;
/** Destructive or deploy-requesting: confirmed by a human under every preset, whatever the agent may do. */
const ALWAYS_CONFIRMED = ['delete', 'archive', 'request_deploy'] as const;
/** The runner's own My-scope work: the existing rule (read-only holds; otherwise gate 2 decides). */
const PERSONAL_PLATFORM_WRITES = ['create_software', 'use_connection', 'use_data', 'use_knowledge', 'use_as_data', 'start_preview'] as const;

test('platform writes: all eleven (and the two approvals outside the platform surface) are WRITES the hold gate can see', () => {
  for (const t of [...HUMAN_ONLY_APPROVALS, ...ALWAYS_CONFIRMED, ...PERSONAL_PLATFORM_WRITES]) {
    assert.equal(isWriteTool(t), true, `${t} must be in the hold table or no preset can hold it`);
  }
});

test('platform writes: the WHOLE declared surface has a stated posture — classified is not held', () => {
  // The fifteen `write: true` tools of the platform-MCP surface, as a literal (this tab may not
  // import the software tab; `tabs/software/lib/builder/dispatch.test.ts` pins the same fifteen
  // against the real `PLATFORM_MCP_TOOLS`, so the two halves cannot drift).
  const personal = [...PERSONAL_PLATFORM_WRITES, 'commit', 'push_app_files', 'set_app_spec', 'design_software'];
  const all = [...PLATFORM_APPROVALS, ...ALWAYS_CONFIRMED, ...personal];
  assert.equal(new Set(all).size, 15, 'every platform write sits in exactly one posture bucket');
  for (const t of HUMAN_ONLY_APPROVALS) assert.ok(agentForbiddenReason(t), `${t}: refused`);
  for (const t of [...ALWAYS_CONFIRMED, ...personal]) assert.equal(agentForbiddenReason(t), null, `${t}: not refused`);
  for (const preset of ALL_PRESETS) {
    for (const t of [...HUMAN_ONLY_APPROVALS, ...ALWAYS_CONFIRMED]) assert.equal(holdDecisionFor(preset, t).held, true, `${preset} holds ${t}`);
    for (const t of personal) assert.equal(holdDecisionFor(preset, t).held, preset === 'read-only', `${preset}/${t}`);
  }
});

for (const tool of ALWAYS_CONFIRMED) {
  test(`posture: ${tool} is HELD under EVERY preset — an agent's rights never waive the confirmation`, () => {
    assert.equal(writeTargetScope(tool), 'domain', `${tool} must never default to personal`);
    // read-only blocks every write to a platform admin (the pre-existing blanket rule)…
    assert.deepEqual(holdDecisionFor('read-only', tool), { held: true, approverRole: 'admin' });
    // …and under every OTHER preset — `full-in-scope` included — it still parks, on the domain gate.
    for (const preset of ['read-propose', 'read-bounded', 'full-in-scope'] as const) {
      assert.deepEqual(holdDecisionFor(preset, tool), { held: true, approverRole: 'domain_admin' }, `${preset} must hold ${tool}`);
    }
  });

  test(`executor: a full-in-scope agent granted ${tool} is HELD, enqueued, and never dispatched`, async () => {
    const deps = spyDeps();
    const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'full-in-scope'), 'sys1', deps);
    const res = await exec(tool, { appId: 'app_1' });
    assert.equal(res.isError, true);
    assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, 'held');
    assert.equal(deps.calls.enqueue.length, 1, 'the confirmation request is filed');
    assert.equal((deps.calls.enqueue[0] as { approverRole?: string }).approverRole, 'domain_admin');
    assert.equal(deps.calls.handleRpc.length, 0, 'a held write is never executed');
  });
}

for (const tool of PERSONAL_PLATFORM_WRITES) {
  test(`posture: ${tool} is a My-scope write — read-only HOLDS it, an agent with rights in scope is not held`, () => {
    assert.equal(writeTargetScope(tool), 'personal');
    assert.deepEqual(holdDecisionFor('read-only', tool), { held: true, approverRole: 'admin' });
    for (const preset of ['read-propose', 'read-bounded', 'full-in-scope'] as const) {
      assert.deepEqual(holdDecisionFor(preset, tool), { held: false }, `${preset}: gate 2 (the runner's own rights) is the authority`);
    }
    // Mirrors `set_app_spec` exactly — one rule for the runner's own software work.
    for (const preset of ALL_PRESETS) {
      assert.deepEqual(holdDecisionFor(preset, tool), holdDecisionFor(preset, 'set_app_spec'), `${preset}: same posture as set_app_spec`);
    }
  });
}

test('executor: read-only HOLDS create_software (it ran unheld while it was unclassified)', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset(['create_software'], 'read-only'), 'sys1', deps);
  const res = await exec('create_software', { name: 'x' });
  assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, 'held');
  assert.equal(deps.calls.enqueue.length, 1);
  assert.equal(deps.calls.handleRpc.length, 0);
});

for (const tool of HUMAN_ONLY_APPROVALS) {
  test(`approvals are human: an agent run may not call ${tool} AT ALL — refused, not held`, async () => {
    const deps = spyDeps();
    // Granted, most permissive preset, an ADMIN runner: nothing but the door itself can be refusing.
    const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'full-in-scope'), 'sys1', deps);
    const res = await exec(tool, { appId: 'app_1', decision: 'approve' });
    assert.equal(res.isError, true);
    const err = JSON.parse(res.text) as { error: { code: string; reason: string } };
    assert.equal(err.error.code, 'forbidden');
    assert.match(err.error.reason, /human decision/);
    assert.match(err.error.reason, /four-eyes/);
    assert.equal(deps.calls.handleRpc.length, 0, 'never dispatched');
    assert.equal(deps.calls.enqueue.length, 0, 'and not enqueued — a hold could be approved and then FIRE it');
  });

  test(`approvals are human: ${tool} is never ADVERTISED to a model, even when a system grants it`, () => {
    // `request_deploy` is granted beside it as the control: the platform bundle IS registered and
    // an admin clears every role floor, so the only thing that can be hiding `${tool}` is the door.
    const specs = grantedToolSpecs(ADMIN_USER, sysWithPreset([tool, 'request_deploy'], 'full-in-scope')).map((t) => t.name);
    assert.ok(specs.includes('request_deploy'), 'control: a sibling platform write is advertised');
    assert.ok(!specs.includes(tool), 'a schema the gate will refuse must not be offered');
  });

  test(`approvals are human: ${tool} is ALSO company-held behind the refusal — the second line`, () => {
    // If a future door reaches the hold instead of gate 0, the answer must be "an admin decides",
    // never "personal, run it" (the reindex_corpus belt-and-braces, applied to approvals).
    assert.equal(writeTargetScope(tool), 'company');
    for (const preset of ALL_PRESETS) assert.deepEqual(holdDecisionFor(preset, tool), { held: true, approverRole: 'admin' });
  });
}

// --- 2026-11-19: the nine-tool backlog, decided (owner's decision) -----------------------------
//
// `revoke_action_adoption`, `retire_connection`, `request_certification`,
// `update_operating_manual`, `restore_operating_manual_version`, `create_connection`,
// `configure_connection`, `test_connection` and `build_software` were in the MCP registry and in
// NO hold table, so `holdDecisionFor(preset, name)` answered "not a write" under every preset.
// Same three postures as the platform writes above; one more routing rule (who confirms).

/** Closed to agent runs: a domain admin's governance decision, the inverse of an approval. */
const BACKLOG_FORBIDDEN = ['revoke_action_adoption'] as const;
/** Held under every preset, confirmed by a domain admin: ONE artifact in ONE domain. */
const BACKLOG_CONFIRMED_BY_DOMAIN_ADMIN = ['retire_connection', 'request_certification'] as const;
/** Held under every preset, confirmed by a PLATFORM admin: the name-only gate cannot see which
 *  Operating Model scope the call targets, and the widest one (Company) is admin-only to edit. */
const BACKLOG_CONFIRMED_BY_ADMIN = ['update_operating_manual', 'restore_operating_manual_version'] as const;
/** The runner's own My-scope work: read-only holds; otherwise gate 2 (their own rights) decides. */
const BACKLOG_PERSONAL = ['create_connection', 'configure_connection', 'test_connection', 'build_software'] as const;

test('backlog: all nine are WRITES the hold gate can see, each in exactly one posture bucket', () => {
  const all = [...BACKLOG_FORBIDDEN, ...BACKLOG_CONFIRMED_BY_DOMAIN_ADMIN, ...BACKLOG_CONFIRMED_BY_ADMIN, ...BACKLOG_PERSONAL];
  assert.equal(new Set(all).size, 9);
  for (const t of all) assert.equal(isWriteTool(t), true, `${t} must be in the hold table or no preset can hold it`);
  for (const t of BACKLOG_FORBIDDEN) assert.ok(agentForbiddenReason(t), `${t}: refused`);
  for (const t of all.filter((n) => !(BACKLOG_FORBIDDEN as readonly string[]).includes(n))) {
    assert.equal(agentForbiddenReason(t), null, `${t}: not refused`);
  }
  for (const preset of ALL_PRESETS) {
    for (const t of [...BACKLOG_FORBIDDEN, ...BACKLOG_CONFIRMED_BY_DOMAIN_ADMIN, ...BACKLOG_CONFIRMED_BY_ADMIN]) {
      assert.equal(holdDecisionFor(preset, t).held, true, `${preset} holds ${t}`);
    }
    for (const t of BACKLOG_PERSONAL) assert.equal(holdDecisionFor(preset, t).held, preset === 'read-only', `${preset}/${t}`);
  }
});

for (const tool of BACKLOG_FORBIDDEN) {
  test(`backlog: an agent run may not call ${tool} AT ALL — refused at gate 0, not held`, async () => {
    const deps = spyDeps();
    const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'full-in-scope'), 'sys1', deps);
    const res = await exec(tool, { adoptionId: 'ad_1' });
    assert.equal(res.isError, true);
    const err = JSON.parse(res.text) as { error: { code: string; reason: string } };
    assert.equal(err.error.code, 'forbidden');
    assert.match(err.error.reason, /human decision, not an agent action/);
    assert.match(err.error.reason, /domain admin/);
    assert.equal(deps.calls.handleRpc.length, 0, 'never dispatched');
    assert.equal(deps.calls.enqueue.length, 0, 'and not enqueued — a hold could be approved and then FIRE it');
  });

  test(`backlog: ${tool} is never ADVERTISED to a model, even when a system grants it`, () => {
    const specs = grantedToolSpecs(ADMIN_USER, sysWithPreset([tool, 'retire_connection'], 'full-in-scope')).map((t) => t.name);
    assert.ok(specs.includes('retire_connection'), 'control: a sibling connection tool is advertised');
    assert.ok(!specs.includes(tool), 'a schema the gate will refuse must not be offered');
  });

  test(`backlog: ${tool} is ALSO company-held behind the refusal — the second line`, () => {
    assert.equal(writeTargetScope(tool), 'company');
    for (const preset of ALL_PRESETS) assert.deepEqual(holdDecisionFor(preset, tool), { held: true, approverRole: 'admin' });
  });
}

for (const [tools, approverRole, scope] of [
  [BACKLOG_CONFIRMED_BY_DOMAIN_ADMIN, 'domain_admin', 'domain'],
  [BACKLOG_CONFIRMED_BY_ADMIN, 'admin', 'company'],
] as const) {
  for (const tool of tools) {
    test(`backlog: ${tool} is HELD under EVERY preset, for a ${approverRole}`, () => {
      assert.equal(writeTargetScope(tool), scope, `${tool} must never default to personal`);
      assert.deepEqual(holdDecisionFor('read-only', tool), { held: true, approverRole: 'admin' });
      for (const preset of ['read-propose', 'read-bounded', 'full-in-scope'] as const) {
        assert.deepEqual(holdDecisionFor(preset, tool), { held: true, approverRole }, `${preset} must hold ${tool}`);
      }
      // Whoever confirms, the card reads "always confirmed" — never "the preset held it".
      const r = holdReason(tool);
      assert.equal(r.label, 'always-confirmed');
      assert.match(r.why, /always confirmed by a second person, whatever the system's safety preset/);
    });

    test(`backlog executor: a full-in-scope agent granted ${tool} is HELD, enqueued for a ${approverRole}, never dispatched`, async () => {
      const deps = spyDeps();
      const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'full-in-scope'), 'sys1', deps);
      const res = await exec(tool, { connId: 'conn_1', scope: 'my', kind: 'knowledge', id: 'wf_1' });
      assert.equal(res.isError, true);
      assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, 'held');
      assert.equal(deps.calls.enqueue.length, 1, 'the confirmation request is filed');
      assert.equal((deps.calls.enqueue[0] as { approverRole?: string }).approverRole, approverRole);
      assert.equal(deps.calls.handleRpc.length, 0, 'a held write is never executed');
    });
  }
}

test('backlog: the Operating Model card says a PLATFORM admin confirms, and why the scope cannot be read', () => {
  for (const tool of BACKLOG_CONFIRMED_BY_ADMIN) {
    assert.match(holdReason(tool).why, /platform admin/);
    assert.match(holdReason(tool).why, /Company/);
  }
  // The domain-routed ones must NOT claim a platform admin is needed.
  for (const tool of [...BACKLOG_CONFIRMED_BY_DOMAIN_ADMIN, ...ALWAYS_CONFIRMED]) {
    assert.doesNotMatch(holdReason(tool).why, /platform admin/, tool);
  }
  // Each reason is about THAT tool: a connection is not "a go-live", a request is not "destructive".
  assert.match(holdReason('retire_connection').why, /connection/);
  assert.match(holdReason('request_certification').why, /Domain → Company/);
  assert.match(holdReason('delete').why, /destructive/);
  assert.match(holdReason('request_deploy').why, /go-live/);
});

for (const tool of BACKLOG_PERSONAL) {
  test(`backlog: ${tool} is a My-scope write — read-only HOLDS it, otherwise the runner's own rights decide`, () => {
    assert.equal(writeTargetScope(tool), 'personal');
    assert.deepEqual(holdDecisionFor('read-only', tool), { held: true, approverRole: 'admin' });
    for (const preset of ['read-propose', 'read-bounded', 'full-in-scope'] as const) {
      assert.deepEqual(holdDecisionFor(preset, tool), { held: false }, `${preset}: gate 2 is the authority`);
    }
    assert.equal(holdReason(tool).label, 'personal-scope');
  });

  test(`backlog executor: read-only HOLDS ${tool} (it ran unheld while it was unclassified); read-propose runs it as the runner`, async () => {
    const held = spyDeps();
    const res = await grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'read-only'), 'sys1', held)(tool, { connId: 'c1', appId: 'a1' });
    assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, 'held');
    assert.equal(held.calls.enqueue.length, 1);
    assert.equal(held.calls.handleRpc.length, 0);
    const free = spyDeps();
    await grantedToolExecutor(ADMIN_USER, sysWithPreset([tool], 'read-propose'), 'sys1', free)(tool, { connId: 'c1', appId: 'a1' });
    assert.equal(free.calls.enqueue.length, 0, `${tool} is not held outside read-only`);
    assert.equal(free.calls.handleRpc.length, 1, `${tool} is dispatched as the acting user`);
    assert.equal((free.calls.handleRpc[0] as { user: CurrentUser }).user, ADMIN_USER);
  });
}

test('holdDecision: read-only holds all; personal never held; domain→domain_admin', () => {
  // read-only blocks every write (any target).
  assert.deepEqual(holdDecision('read-only', 'create_dataset'), { held: true, approverRole: 'admin' });
  // personal create is NEVER held under any non-read-only preset.
  for (const p of ['read-propose', 'read-bounded', 'full-in-scope'] as const) {
    assert.deepEqual(holdDecision(p, 'create_dataset'), { held: false }, `${p} personal not held`);
    assert.deepEqual(holdDecision(p, 'upload_file'), { held: false });
  }
  // Domain escalation → held to domain_admin.
  assert.deepEqual(holdDecision('read-propose', 'publish_workflow'), { held: true, approverRole: 'domain_admin' });
  assert.deepEqual(holdDecision('full-in-scope', 'request_promotion'), { held: true, approverRole: 'domain_admin' });
});

test('executor: read-propose does NOT hold personal create/upload/author/define/connection', async () => {
  for (const tool of ['create_dataset', 'upload_file', 'author_workflow', 'define_metric', 'create_connection']) {
    const deps = spyDeps();
    const exec = grantedToolExecutor(CREATOR, sysWithPreset([tool], 'read-propose'), 'sys1', deps);
    const res = await exec(tool, { name: 'x', title: 'x', datasetId: 'ds1', aggregation: 'count' });
    assert.equal(deps.calls.enqueue.length, 0, `${tool} NOT held`);
    assert.equal(deps.calls.handleRpc.length, 1, `${tool} ran run-as-user`);
    assert.equal((deps.calls.handleRpc[0] as { user: CurrentUser }).user, CREATOR);
    assert.equal(res.text, `ran ${tool}`);
  }
});

test('executor: promoting to Domain is HELD and enqueued to domain_admin', async () => {
  const deps = spyDeps();
  // read-propose (or any non-read-only): a Domain escalation is still held.
  const exec = grantedToolExecutor(BUILDER, sysWithPreset(['publish_workflow'], 'full-in-scope'), 'sys1', deps);
  const res = await exec('publish_workflow', { workflowId: 'wf1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /requires domain_admin approval/);
  assert.equal(deps.calls.handleRpc.length, 0, 'NEVER executed');
  assert.equal(deps.calls.enqueue.length, 1);
  const item = deps.calls.enqueue[0] as { tool: string; approverRole: string; requestedBy: string; agent: string };
  assert.equal(item.tool, 'publish_workflow');
  assert.equal(item.approverRole, 'domain_admin');
  assert.equal(item.requestedBy, 'u2');
  assert.equal(item.agent, 'os-sys1');
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

// --- RUN-REPORT HONESTY: write-outcome accounting (counted, never inferred) ------

/** A held step's typed envelope (the exact shape errorResult('held', …) produces). */
const HELD = JSON.stringify({ error: { code: 'held', reason: 'requires domain_admin approval' } });
/** A non-policy execution error (a Trino/engine failure) — must NOT count as held. */
const EXEC_ERR = JSON.stringify({ error: { code: 'bad_request', reason: 'bad sql' } });

test('summarizeWriteOutcomes: counts direct My-writes by tab, held separately, ignores reads', () => {
  const o = summarizeWriteOutcomes([
    { tool: 'create_dataset', result: 'ok', isError: false },    // direct → My Data
    { tool: 'ingest_dataset', result: 'ok', isError: false },    // direct → My Data
    { tool: 'define_metric', result: 'ok', isError: false },     // direct → My Metrics
    { tool: 'query_data', result: 'rows', isError: false },      // a READ — ignored
    { tool: 'publish_workflow', result: HELD, isError: true },  // held → Governance
  ]);
  assert.equal(o.wroteTotal, 3);
  assert.equal(o.heldTotal, 1);
  const byTab = Object.fromEntries(o.wrote.map((g) => [g.tab, g.count]));
  assert.equal(byTab['Data'], 2);
  assert.equal(byTab['Metrics'], 1);
});

test('summarizeWriteOutcomes: a NON-held execution error is neither written nor held', () => {
  const o = summarizeWriteOutcomes([{ tool: 'create_dataset', result: EXEC_ERR, isError: true }]);
  assert.equal(o.wroteTotal, 0, 'a failed write did not write');
  assert.equal(o.heldTotal, 0, 'a failed write is not "held for approval"');
});

test('summarizeWriteOutcomes: resolves legacy aliases (write_file → upload_file → Files)', () => {
  const o = summarizeWriteOutcomes([{ tool: 'write_file', result: 'ok', isError: false }]);
  assert.equal(o.wroteTotal, 1);
  assert.equal(o.wrote[0].tab, 'Files');
});

test('writeOutcomesLine: honest sentences for direct + held, empty when nothing wrote', () => {
  assert.equal(writeOutcomesLine(summarizeWriteOutcomes([{ tool: 'query_data', result: 'r', isError: false }])), '');
  const line = writeOutcomesLine(summarizeWriteOutcomes([
    { tool: 'define_metric', result: 'ok', isError: false },
    { tool: 'publish_workflow', result: HELD, isError: true },
  ]));
  assert.match(line, /Wrote 1 record directly — 1 to My Metrics\./);
  assert.match(line, /1 write awaiting approval in Governance → Inbox\./);
});

// --- Phase-0 regression gate: agent resource narrowing (review finding 1) ------

function sysWithDataGrant(datasetId: string, layer: 'bronze' | 'silver' | 'gold'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools: ['get_dataset'], data: [{ id: datasetId, capability: 'Read', layer }] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

// No longer a `todo`: the executor's resource-grant check (gate 1a, `grant-scope.ts`) is what this
// regression gate was waiting for.
test('RESOURCE-NARROWING: get_dataset on an UNGRANTED dataset is refused before dispatch', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataGrant('ds-A', 'gold'), 'sys-1', deps);
  const res = await exec('get_dataset', { datasetId: 'ds-B' });
  assert.equal(deps.calls.handleRpc.length, 0, 'ds-B is not in grants.data — must never reach handleRpc');
  assert.equal(res.isError, true);
  assert.match(res.text, /not granted|forbidden/i);
});

test('RESOURCE-NARROWING: an explicit layer below the granted layer is clamped, not forwarded', { todo: 'fixed in Phase 1' }, async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(CREATOR, sysWithDataGrant('ds-A', 'gold'), 'sys-1', deps);
  await exec('get_dataset', { datasetId: 'ds-A', layer: 'bronze' });
  assert.equal(deps.calls.handleRpc.length, 1);
  const call = deps.calls.handleRpc[0] as { req: { params: { arguments: { layer?: string } } } };
  assert.equal(call.req.params.arguments.layer, 'gold', 'the grant says gold; bronze must not pass through');
});

// --- Phase-0 regression gate: held writes lose their arguments (review finding 5) ------

test('HELD-ACTION: a held request_promotion must carry the exact arguments it needs to execute later', { todo: 'fixed in Phase 2' }, async () => {
  const queued: Record<string, unknown>[] = [];
  const deps: OsToolDeps = {
    enqueue: ((item: Record<string, unknown>) => { queued.push(item); return { id: 'q1' }; }) as unknown as OsToolDeps['enqueue'],
    trace: (async () => {}) as unknown as OsToolDeps['trace'],
    handleRpc: (async () => { throw new Error('must not dispatch a held write'); }) as unknown as OsToolDeps['handleRpc'],
  };
  const sys = sysWithPreset(['request_promotion'], 'read-propose');
  const args = { kind: 'dataset', id: 'ds-A', target: 'Domain', reason: 'gate test' };
  const res = await grantedToolExecutor(CREATOR, sys, 'sys-1', deps)('request_promotion', args);
  assert.equal(res.isError, true);
  assert.match(res.text, /held/);
  assert.equal(queued.length, 1, 'exactly one approval queued');
  assert.deepEqual((queued[0] as { action?: { args?: unknown } }).action?.args, args,
    'the queued approval has no arguments — approve → execute → resume is impossible');
});

// --- engine rebuild A0: an explicit empty node tool list means NO tools -----------

test("grantedToolSpecs: an explicit empty node `tools: []` advertises NO tools; an absent list inherits every grant", () => {
  const sys = sysWith(['query_data', 'search_knowledge']);
  // Absent → inherit the whole (role-scoped) granted set, as before.
  assert.ok(grantedToolSpecs(CREATOR, sys).map((s) => s.name).includes('query_data'));
  assert.ok(grantedToolSpecs(CREATOR, sys, undefined).map((s) => s.name).includes('search_knowledge'));
  // Explicit [] → nothing. The Software Delivery Team's orchestrator (`tools: []`, "do no
  // building yourself") must never be handed create_software/commit.
  assert.deepEqual(grantedToolSpecs(CREATOR, sys, []), []);
  // A non-empty list still narrows (plus discovery companions), unchanged.
  const narrowed = grantedToolSpecs(CREATOR, sys, ['search_knowledge']).map((s) => s.name);
  assert.ok(narrowed.includes('search_knowledge'));
  assert.ok(!narrowed.includes('query_data'));
});

test('holdReason: the card says WHY, and never blames the preset for a hold no preset can lift', () => {
  // Review L3: every held call used to read "held by the system's safety preset". For `delete`
  // that is false under read-propose and full-in-scope, and it tells the approver the wrong fix.
  for (const t of ALWAYS_CONFIRMED) {
    const r = holdReason(t);
    assert.equal(r.label, 'always-confirmed');
    assert.match(r.why, /always confirmed by a second person, whatever the system's safety preset/);
  }
  assert.match(holdReason('request_promotion').why, /My → Domain boundary.*under every safety preset/);
  assert.match(holdReason('reindex_corpus').why, /platform admin decides it under every safety preset/);
  // Only a My-scope write is held BY the preset — and only read-only does that.
  assert.equal(holdReason('create_dataset').label, 'personal-scope');
  assert.match(holdReason('create_dataset').why, /read-only safety preset holds every write/);
  // The label agrees with the scope the decision is made on, for every catalogued family.
  for (const t of ['delete', 'request_promotion', 'reindex_corpus', 'create_dataset']) {
    const scope = writeTargetScope(t);
    if (!(ALWAYS_CONFIRMED as readonly string[]).includes(t)) assert.equal(holdReason(t).label, `${scope}-scope`);
  }
});

test('executor: the enqueued card for an always-confirmed call carries the true reason', async () => {
  const deps = spyDeps();
  const exec = grantedToolExecutor(ADMIN_USER, sysWithPreset(['delete'], 'full-in-scope'), 'sys1', deps);
  await exec('delete', { appId: 'app_1' });
  const card = deps.calls.enqueue[0] as { detail: string };
  assert.match(card.detail, /always-confirmed write 'delete'/);
  assert.match(card.detail, /whatever the system's safety preset/);
  assert.doesNotMatch(card.detail, /held by the system's safety preset/);
});

// --- RESOURCE GRANTS at the executor (gate 1a) — F6 -------------------------------------------
//
// The rule itself is unit-tested in `grant-scope.test.ts`. These pin WHERE it sits: in the one
// executor every agent tool call goes through, before the hold and before the tool, and that the
// call which does pass still runs as the signed-in user.

import { agentToolGate } from '@tabs/agents/lib/build/os-tools';
import type { GrantResolvers } from '@tabs/agents/lib/build/grant-scope';

function sysGranting(tools: string[], grants: Record<string, unknown>, preset = 'full-in-scope'): System {
  return parseSystem({
    version: '1',
    system: { name: 'T', domain: 'sales', visibility: 'Personal' },
    entrypoint: 'a',
    safety_preset: preset,
    grants: { tools, ...grants },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
}

const GRANT_RESOLVERS: GrantResolvers = {
  fileLocations: async () => [
    { id: 'f_inv', folder: '/Invoices/2026', lane: 'personal' },
    { id: 'f_hr', folder: '/HR', lane: 'personal' },
  ],
  datasetTables: async (id) => (id === 'ds_orders' ? ['iceberg.sales.gold_orders'] : id === 'ds_new' ? ['iceberg.personal_u1.bronze_new'] : []),
};

/** A spy `handleRpc` that answers each tool with a canned JSON result. */
function answering(results: Record<string, unknown>) {
  return spyDeps({
    resolvers: GRANT_RESOLVERS,
    handleRpc: (async (_user, req) => {
      const name = (req.params as { name?: string })?.name ?? '';
      return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(results[name] ?? { ran: name }) }] } };
    }) as OsToolDeps['handleRpc'],
  });
}

const errorOf = (r: { text: string }): { code?: string; reason?: string; kind?: string; id?: string } => {
  try { return (JSON.parse(r.text) as { error?: Record<string, string> }).error ?? {}; } catch { return {}; }
};

test('F6: a call naming a dataset OUTSIDE the grants is refused before the tool runs — typed forbidden, tool never dispatched', async () => {
  const sys = sysGranting(['query_data'], { data: [{ id: 'ds_orders', capability: 'Read' }] });
  const calls: string[] = [];
  const deps = spyDeps({
    resolvers: GRANT_RESOLVERS,
    handleRpc: (async (_u, req) => { calls.push((req.params as { name: string }).name); return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"id":"x"}' }] } }; }) as OsToolDeps['handleRpc'],
  });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  const no = await exec('get_dataset', { datasetId: 'ds_salaries' });
  assert.equal(no.isError, true);
  assert.deepEqual({ code: errorOf(no).code, kind: errorOf(no).kind, id: errorOf(no).id }, { code: 'forbidden', kind: 'data', id: 'ds_salaries' });
  assert.match(errorOf(no).reason ?? '', /This agent is not granted dataset ds_salaries/);
  assert.deepEqual(calls, [], 'the tool was never dispatched');
  const yes = await exec('get_dataset', { datasetId: 'ds_orders' });
  assert.equal(yes.isError, false);
  assert.deepEqual(calls, ['get_dataset']);
});

test('F6: the call that passes still runs AS THE SIGNED-IN USER (the grant check only narrows)', async () => {
  const sys = sysGranting(['query_data'], { data: [{ id: 'ds_orders', capability: 'Read' }] });
  const deps = spyDeps({ resolvers: GRANT_RESOLVERS });
  await grantedToolExecutor(CREATOR, sys, 'sys_g', deps)('get_dataset', { datasetId: 'ds_orders' });
  const [call] = deps.calls.handleRpc as { user: CurrentUser }[];
  assert.equal(call.user.id, CREATOR.id);
});

test('F6: an EXISTING system with no resource grants behaves exactly as before', async () => {
  const sys = sysGranting(['query_data', 'get_file', 'search_knowledge'], {});
  const deps = spyDeps({ resolvers: { fileLocations: async () => { throw new Error('not consulted'); }, datasetTables: async () => { throw new Error('not consulted'); } } });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  for (const [tool, args] of [['get_dataset', { datasetId: 'ds_any' }], ['query_data', { sql: 'select 1 from t' }], ['get_file', { fileId: 'f_any' }], ['search_knowledge', { query: 'q' }]] as const) {
    const r = await exec(tool, args);
    assert.equal(r.isError, false, `${tool} is not restricted when nothing is granted`);
    assert.equal(r.text, `ran ${tool}`, 'and its result is passed through untouched');
  }
  assert.equal(deps.calls.handleRpc.length, 4);
});

test('F6: free-form SQL is checked against the granted datasets\' tables before it runs', async () => {
  const sys = sysGranting(['query_data'], { data: [{ id: 'ds_orders', capability: 'Read' }] });
  const deps = answering({ query_data: { rows: [[1]] } });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  assert.equal((await exec('query_data', { sql: 'SELECT count(*) FROM iceberg.sales.gold_orders' })).isError, false);
  const no = await exec('query_data', { sql: 'SELECT * FROM iceberg.hr.gold_salaries' });
  assert.equal(errorOf(no).code, 'forbidden');
  assert.match(errorOf(no).reason ?? '', /not granted the table iceberg\.hr\.gold_salaries/);
  const unknown = await exec('query_data', { sql: 'SHOW SCHEMAS' });
  assert.match(errorOf(unknown).reason ?? '', /cannot be checked/);
});

test('F6: a FILES folder grant restricts get_file (subfolders included) and search_files', async () => {
  const sys = sysGranting(['get_file'], { files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] });
  const deps = answering({ get_file: { id: 'f_inv', name: 'a.pdf', text: 'hello' }, search_files: [{ id: 'f_inv', name: 'a.pdf' }, { id: 'f_hr', name: 'pay.pdf' }] });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  assert.equal((await exec('get_file', { fileId: 'f_inv' })).isError, false);
  const no = await exec('get_file', { fileId: 'f_hr' });
  assert.equal(errorOf(no).code, 'forbidden');
  assert.match(errorOf(no).reason ?? '', /not granted file f_hr/);
  const found = JSON.parse((await exec('search_files', { query: 'pdf' })).text) as { items: { id: string }[] };
  assert.deepEqual(found.items.map((i) => i.id), ['f_inv']);
});

test('F6: search_knowledge and list_datasets come back narrowed to the granted items', async () => {
  const sys = sysGranting(['search_knowledge', 'query_data'], { knowledge: [{ id: 'wf_ok', capability: 'Read' }], data: [{ id: 'ds_orders', capability: 'Read' }] });
  const deps = answering({
    search_knowledge: { decision: 'allow', hits: [{ unit: { id: 'u1', provenance: { workflowId: 'wf_ok' } } }, { unit: { id: 'u2', provenance: { workflowId: 'wf_other' } } }] },
    list_datasets: { mine: [{ id: 'ds_orders' }, { id: 'ds_private' }], domain: [], marketplace: [] },
  });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  const hits = JSON.parse((await exec('search_knowledge', { query: 'x' })).text) as { hits: { unit: { id: string } }[] };
  assert.deepEqual(hits.hits.map((h) => h.unit.id), ['u1']);
  const list = JSON.parse((await exec('list_datasets', {})).text) as { mine: { id: string }[] };
  assert.deepEqual(list.mine.map((d) => d.id), ['ds_orders']);
});

test('F6: a Read grant refuses a write on that dataset — and nothing is queued for approval', async () => {
  const sys = sysGranting(['ingest_dataset'], { data: [{ id: 'ds_orders', capability: 'Read' }] }, 'read-only');
  const deps = spyDeps({ resolvers: GRANT_RESOLVERS });
  const r = await grantedToolExecutor(CREATOR, sys, 'sys_g', deps)('ingest_dataset', { datasetId: 'ds_orders', content: 'a,b' });
  assert.equal(errorOf(r).code, 'forbidden');
  assert.match(errorOf(r).reason ?? '', /read-only/);
  assert.equal(deps.calls.enqueue.length, 0, 'a refused call is not sent to an approver');
  assert.equal(deps.calls.handleRpc.length, 0);
});

test('F6: what the run CREATES is usable afterwards — in the same run, and after a resume through the seed', async () => {
  const sys = sysGranting(['create_dataset', 'ingest_dataset', 'query_data'], { data: [{ id: 'ds_orders', capability: 'Read' }] });
  const deps = answering({ create_dataset: { id: 'ds_new', name: 'New' } });
  const exec = grantedToolExecutor(CREATOR, sys, 'sys_g', deps);
  assert.equal(errorOf(await exec('get_dataset', { datasetId: 'ds_new' })).code, 'forbidden');
  assert.equal((await exec('create_dataset', { name: 'New' })).isError, false);
  assert.equal((await exec('ingest_dataset', { datasetId: 'ds_new', content: 'a,b' })).isError, false);
  assert.equal((await exec('query_data', { sql: 'select * from iceberg.personal_u1.bronze_new' })).isError, false);
  // A resumed run builds a NEW executor: the ledger comes back through `createdSeed`.
  const resumed = grantedToolExecutor(CREATOR, sys, 'sys_g', answering({}), { createdSeed: { data: ['ds_new'] } });
  assert.equal((await resumed('get_dataset', { datasetId: 'ds_new' })).isError, false);
});

test('F6: `precheck` gives the same answer ahead of time, and stays silent for calls the other gates answer', async () => {
  const sys = sysGranting(['ingest_dataset'], { data: [{ id: 'ds_orders', capability: 'Read' }] });
  const gate = agentToolGate(CREATOR, sys, 'sys_g', spyDeps({ resolvers: GRANT_RESOLVERS }));
  const no = await gate.precheck('ingest_dataset', { datasetId: 'ds_orders', content: 'a' });
  assert.equal(errorOf(no!).code, 'forbidden');
  assert.equal(errorOf((await gate.precheck('ingest_dataset', { datasetId: 'ds_other', content: 'a' }))!).id, 'ds_other');
  assert.equal(await gate.precheck('create_software', { name: 'x' }), null, 'not granted → the tool-name gate answers, not this one');
  assert.equal(await gate.precheck('decide_approval', { requestId: 'r', decision: 'approve' }), null, 'closed to agents → gate 0 answers');
});

test('F6: the agent-forbidden tools stay refused by gate 0 whatever the resource grants say', async () => {
  const sys = sysGranting(['decide_approval', 'promote_connection'], { connections: [{ id: 'conn_1', capability: 'Write-bounded' }] });
  const deps = spyDeps({ resolvers: GRANT_RESOLVERS });
  const exec = grantedToolExecutor(ADMIN_USER, sys, 'sys_g', deps);
  for (const [tool, args] of [['decide_approval', { requestId: 'r', decision: 'approve' }], ['promote_connection', { connId: 'conn_1' }]] as const) {
    const r = await exec(tool, args);
    assert.equal(errorOf(r).code, 'forbidden');
    assert.match(errorOf(r).reason ?? '', /human decision/);
  }
  assert.equal(deps.calls.handleRpc.length, 0);
});

test('F6: when the grant check itself cannot be made, the call is refused — never run on trust', async () => {
  const sys = sysGranting(['get_file'], { files: [{ folder: { path: '/Invoices', scope: 'personal' }, capability: 'Read' }] });
  const deps = spyDeps({ resolvers: { fileLocations: async () => { throw new Error('file index unavailable'); }, datasetTables: async () => [] } });
  const r = await grantedToolExecutor(CREATOR, sys, 'sys_g', deps)('get_file', { fileId: 'f_inv' });
  assert.equal(errorOf(r).code, 'forbidden');
  assert.match(errorOf(r).reason ?? '', /could not be checked against the system's resource grants \(file index unavailable\)/);
  assert.equal(deps.calls.handleRpc.length, 0);
});

// --- WORKFLOW vs KNOWLEDGE: "save the report as knowledge" can only reach the note tool ---------

/** A team granted what the Simple builder gives a KNOWLEDGE write grant — nothing else. */
function knowledgeWriteTeam(): System {
  return sysGranting(toolsForGrant('knowledge', 'Write-bounded'), { knowledge: [{ id: '', capability: 'Write-bounded', folder: { path: '/results', scope: 'personal' } }] });
}

test('WF/K: a knowledge-write team is OFFERED the note tool and NO workflow tool', () => {
  const offered = new Set(grantedToolSpecs(CREATOR, knowledgeWriteTeam()).map((s) => s.name));
  assert.ok(offered.has('save_knowledge_note'));
  for (const t of ['author_workflow', 'index_workflow', 'publish_workflow', 'retire_workflow', 'list_workflows', 'get_workflow', 'author_knowledge', 'index_knowledge']) {
    assert.ok(!offered.has(t), `${t} must not be offered to a knowledge-write team`);
  }
});

test('WF/K: NEGATIVE TWIN — a knowledge-write team that CALLS author_workflow, or the old author_knowledge, is refused and nothing runs', async () => {
  for (const name of ['author_workflow', 'author_knowledge']) {
    const deps = spyDeps({ resolvers: GRANT_RESOLVERS });
    const r = await grantedToolExecutor(CREATOR, knowledgeWriteTeam(), 'sys_k', deps)(name, { title: 'Daily report' });
    assert.equal(errorOf(r).code, 'not_found', `${name}: not granted`);
    assert.match(r.text, /not granted to this system/);
    assert.equal(deps.calls.handleRpc.length, 0, `${name} must never reach the workflow store`);
  }
  // And the positive twin: the note save is the one that runs.
  const ok = spyDeps({ resolvers: GRANT_RESOLVERS });
  const r = await grantedToolExecutor(CREATOR, knowledgeWriteTeam(), 'sys_k', ok)('save_knowledge_note', { title: 'Daily report', md: 'body', folder: '/results' });
  assert.equal(r.text, 'ran save_knowledge_note');
});

test('WF/K: a team granted WORKFLOW authoring is offered the workflow tool and not the note tool', () => {
  const sys = sysGranting(toolsForGrant('workflows', 'Write-bounded'), { workflows: [{ id: 'wf_a', capability: 'Write-bounded' }] });
  const offered = new Set(grantedToolSpecs(CREATOR, sys).map((s) => s.name));
  assert.ok(offered.has('author_workflow') && offered.has('get_workflow'));
  assert.ok(!offered.has('save_knowledge_note'));
});

test('WF/K: a system saved with the OLD names keeps running — the old name reaches the workflow tool, once logged', async () => {
  const legacy = parseSystem({
    version: '1', system: { name: 'Legacy', domain: 'sales', visibility: 'Personal' }, entrypoint: 'a', safety_preset: 'full-in-scope',
    grants: { tools: ['author_knowledge', 'get_knowledge'], knowledge: [{ id: 'wf_refunds', capability: 'Write-bounded' }] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  const lines: string[] = [];
  const prev = setDeprecationSink((l) => lines.push(l));
  try {
    const deps = spyDeps({ resolvers: GRANT_RESOLVERS });
    const exec = grantedToolExecutor(CREATOR, legacy, 'sys_l', deps);
    const r = await exec('author_knowledge', { title: 'Still works' }); // the name a stored prompt may still use
    assert.equal(r.text, 'ran author_workflow');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /'author_knowledge'.*via agent.*use 'author_workflow'/);
    const r2 = await exec('author_workflow', { title: 'New name' });
    assert.equal(r2.text, 'ran author_workflow');
    assert.equal(lines.length, 1, 'the current name logs nothing');
  } finally {
    setDeprecationSink(prev);
  }
});

test('WF/K: publish_knowledge (old name) is HELD exactly like publish_workflow — the rename cannot lift a hold', async () => {
  for (const name of ['publish_workflow', 'publish_knowledge']) {
    const deps = spyDeps();
    const sys = parseSystem({ version: '1', system: { name: 'T', domain: 'sales', visibility: 'Personal' }, entrypoint: 'a', safety_preset: 'full-in-scope', grants: { tools: [name] }, agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }] });
    const res = await grantedToolExecutor(BUILDER, sys, 'sys1', deps)(name, { workflowId: 'wf1' });
    assert.equal(res.isError, true, `${name} must not execute`);
    assert.match(res.text, /requires domain_admin approval/);
    assert.equal(deps.calls.handleRpc.length, 0);
    assert.equal((deps.calls.enqueue[0] as { tool: string }).tool, 'publish_workflow', 'the queued request names the current tool');
  }
});

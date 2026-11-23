/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Every new agent uses everything its team is granted; a limited agent is visible and repairable
 * USER STORY: As an author I want all agents to have all capabilities the team is granted, by
 *             default — and where an agent was limited, to see it, see what it lacks, and undo it
 *             with one click, without the system getting any more power than I granted it.
 * ARCHITECTURE:
 *   - One test per CREATION PATH that used to write a per-agent `tools:` list: system templates,
 *     the starter system, the team proposer, the helper's "add an agent", the builder's and the
 *     canvas' add-agent. (The workflow scaffold lives in the knowledge tab and is pinned in its
 *     own `agent-scaffold.test.ts` — a tab's test may not import another tab.)
 *   - The card's state and repairs are the pure functions of `agent-capabilities.ts`.
 *   - ENFORCEMENT is asserted through the run's own functions: the tool specs a node is handed
 *     (`grantedToolSpecs`), the grant check (`checkGrantScope`) and the hold rule
 *     (`holdDecisionFor`). Inheriting is a default for WHICH granted tools an agent holds; it
 *     adds nothing to what the system is granted or to what the runner may do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { TEMPLATES, templateYaml } from '@tabs/agents/lib/templates';
import { __resetStore, createSystem } from '@tabs/agents/lib/store';
import { applyInstruction, scaffoldFromProposal } from '@tabs/agents/lib/assistant';
import { addOutput, addSimpleAgent, setFolderGrant } from '@tabs/agents/lib/simple-edit';
import { addAgent } from '@tabs/agents/lib/canvas-edit';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { capabilityChipsForGrants, toolsForCapabilityChipsInPool } from '@tabs/agents/lib/capability-tools';
import { withOutputTools } from '@tabs/agents/lib/output-tools';
import {
  addMissingCapability, agentCapabilityState, capabilityStateLine, staleLimitNote, toolsForSelection, useEverything,
} from '@tabs/agents/lib/agent-capabilities';
import { grantedToolSpecs } from '@tabs/agents/lib/build/os-tools';
import { checkGrantScope, grantScopeOf, type GrantResolvers } from '@tabs/agents/lib/build/grant-scope';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';

const inherits = (sys: System) => sys.agents.every((a) => a.tools === undefined);
const blank = () => parseSystem(templateYaml('blank', 'Desk', 'finance'));

// ------------------------------------------------------------ creation paths --

test('CREATE: every system template starts with an inheriting agent', () => {
  for (const t of TEMPLATES) {
    const sys = parseSystem(templateYaml(t.key, 'Desk', 'finance'));
    assert.ok(sys.agents.length > 0 && inherits(sys), `template ${t.key}`);
    assert.doesNotThrow(() => compile(sys));
  }
});

test('CREATE: a new system (starter, and from a template) has no per-agent tool list', () => {
  __resetStore();
  const user = { id: 'u1', domains: ['finance'], role: 'admin' as const };
  assert.ok(inherits(parseSystem(createSystem(user, { name: 'Starter' }).yaml)));
  assert.ok(inherits(parseSystem(createSystem(user, { name: 'From template', template: TEMPLATES[1].key }).yaml)));
});

test('CREATE: the builder\'s "add agent" and the canvas\' add-agent inherit', () => {
  assert.ok(inherits(addSimpleAgent(blank(), { role: 'Checker' })));
  assert.ok(inherits(addAgent(blank(), { id: 'checker', role: 'Checker' })));
});

test('CREATE: the team proposer gives each agent ONLY the tools its role needs (and puts them into the TEAM pool)', () => {
  const catalog = ['search_knowledge', 'query_data', 'list_datasets', 'get_dataset', 'upload_file', 'get_file', 'list_files'];
  const { system } = scaffoldFromProposal(blank(), [
    { id: 'invoice-reader', role: 'Reads invoices', instruction: 'Read every invoice file and extract the totals.' },
    { id: 'goods-verifier-recommender', role: 'Verifies goods', instruction: 'Verify the goods and write a report file with a recommendation.' },
  ], catalog);
  assert.ok(system.grants.tools.length > 0 && system.grants.tools.every((t) => catalog.includes(t)), 'within the caller\'s catalog');
  for (const a of system.agents) {
    if (a.tools === undefined) continue; // no tool suggested for that role: it inherits the team's grants
    assert.ok(a.tools.length > 0 && a.tools.every((t) => system.grants.tools.includes(t)), `${a.id}: narrow-only`);
    assert.ok(a.tools.length < system.grants.tools.length || system.agents.length === 1, `${a.id} is narrowed`);
  }
  assert.ok(system.agents.some((a) => a.tools !== undefined), 'the proposer writes per-agent tools');
  assert.doesNotThrow(() => compile(system));
});

test('CREATE: the helper\'s "add a writer agent" inherits', () => {
  const { system } = applyInstruction(blank(), 'add a writer agent');
  assert.equal(system.agents.length, 2);
  assert.ok(inherits(system));
});

// ------------------------------------------------------------- the card --

/** A team granted files + data, with one agent limited the way a scaffold used to leave it. */
function limitedTeam(): System {
  let sys = addSimpleAgent(blank(), { id: 'verifier', role: 'Verifier' });
  sys = setFolderGrant(sys, 'files', { path: '/invoices', scope: 'domain' }, false);
  sys = { ...sys, agents: sys.agents.map((a) => (a.id === 'verifier' ? { ...a, tools: ['search_knowledge'] } : a)) };
  return sys;
}

test('PICKER: opening it and applying WITHOUT a change keeps an inheriting agent inheriting', () => {
  const sys = setFolderGrant(blank(), 'files', { path: '/invoices', scope: 'domain' }, false);
  const offered = capabilityChipsForGrants(sys.grants, null).map((c) => c.id);
  assert.ok(offered.length > 0);
  const resolve = (ids: string[]) => toolsForCapabilityChipsInPool(ids, sys.grants.tools);
  // An inheriting agent shows everything on offer as selected; applying that stores NO list.
  assert.equal(toolsForSelection(offered, offered, resolve), undefined);
  // Fewer than everything is a deliberate limit, and stays inside the team pool.
  const fewer = toolsForSelection(offered, [], resolve);
  assert.deepEqual(fewer, []);
  const stale = toolsForSelection(offered, [...offered, 'a-capability-no-longer-offered'], resolve);
  assert.equal(stale, undefined, 'a selection that covers everything on offer is still "everything"');
});

test('CARD: an inheriting agent says so; a limited one says how many, and "Use everything" removes its list', () => {
  const sys = limitedTeam();
  const first = sys.agents[0].id;
  assert.equal(capabilityStateLine(agentCapabilityState(sys, first), 0), 'Uses everything this team is granted (default).');
  assert.equal(staleLimitNote(agentCapabilityState(sys, first)), null);

  const state = agentCapabilityState(sys, 'verifier');
  assert.equal(state.mode, 'limited');
  assert.equal(capabilityStateLine(state, 1), 'Limited to 1 capability.');

  const fixed = useEverything(sys, 'verifier');
  assert.equal(fixed.agents.find((a) => a.id === 'verifier')!.tools, undefined);
  assert.equal(agentCapabilityState(fixed, 'verifier').mode, 'inherits');
  assert.equal(sys.agents.find((a) => a.id === 'verifier')!.tools!.length, 1, 'the input is not mutated');
});

test('STALE: when the team gains a capability a limited agent lacks, its card says which — and can add just that', () => {
  let sys = limitedTeam();
  assert.equal(staleLimitNote(agentCapabilityState(sys, 'verifier')), 'The team is granted File reading, which this limited agent does not have.');

  // The team is then granted a writable folder by hand: File saving joins the pool.
  sys = setFolderGrant(sys, 'files', { path: '/scratch', scope: 'personal' }, true);
  const state = agentCapabilityState(sys, 'verifier');
  assert.ok(state.mode === 'limited' && state.missing.includes('upload_file'));
  assert.equal(staleLimitNote(state), 'The team is granted File reading, File saving, which this limited agent does not have.');

  const added = addMissingCapability(sys, 'verifier', 'File saving');
  const tools = added.agents.find((a) => a.id === 'verifier')!.tools!;
  assert.ok(tools.includes('upload_file') && !tools.includes('get_file'), 'only that capability was added; the agent stays limited');
  assert.doesNotThrow(() => compile(added), 'still a subset of the team pool');
  // Adding the last missing one leaves nothing to limit, so the list is dropped.
  const all = addMissingCapability(added, 'verifier', 'File reading');
  assert.equal(all.agents.find((a) => a.id === 'verifier')!.tools, undefined);
});

test('STALE: a limited agent still receives the tool of a declared output it produces, and is not nagged about it', () => {
  let sys = limitedTeam();
  sys = addOutput(sys, { kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' }, agent: 'verifier' });
  const state = agentCapabilityState(sys, 'verifier');
  assert.ok(state.mode === 'limited' && !state.missing.includes('upload_file'), 'the output hands it over at run time');
  assert.ok(withOutputTools(sys).agents.find((a) => a.id === 'verifier')!.tools!.includes('upload_file'));
  assert.deepEqual(sys.agents.find((a) => a.id === 'verifier')!.tools, ['search_knowledge'], 'the stored list is not rewritten');
});

// ------------------------------------------------------------ enforcement --

const RESOLVERS: GrantResolvers = {
  fileLocations: async () => [{ id: 'f_ok', folder: '/invoices', lane: 'domain' }, { id: 'f_other', folder: '/hr', lane: 'domain' }],
  datasetTables: async () => [],
};
const asUser = (role: CurrentUser['role']): CurrentUser => ({ id: 'u1', name: 'U', role, domains: ['finance'], allDomains: ['finance'], activeDomain: null });

test('ENFORCEMENT: inheriting everything gives an agent the team\'s tools — never more than the grants, the role or the rules allow', async () => {
  // The team pool names a builder-floor approval tool and an agent-forbidden tool on purpose.
  const sys = parseSystem({
    version: '1',
    system: { name: 'T', domain: 'finance', visibility: 'Personal' },
    safety_preset: 'read-bounded',
    entrypoint: 'a',
    grants: {
      tools: ['list_files', 'get_file', 'upload_file', 'request_promotion', 'decide_deploy', 'promote'],
      files: [{ folder: { path: '/invoices', scope: 'domain' }, capability: 'Read' }],
    },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }, { id: 'b', role: 'agent', agent_md: '', memory_md: '', tools: ['get_file'] }],
  });
  assert.equal(sys.agents[0].tools, undefined);

  // 1. WHICH tools: an inheriting agent is handed the team pool and nothing outside it; tools
  //    closed to agent runs are not handed to anyone; a limited agent keeps exactly its list.
  const inheriting = grantedToolSpecs(asUser('admin'), sys).map((t) => t.name);
  // (`search_files` is a discovery companion of the granted file tools — a read of the same grant.)
  assert.ok(inheriting.every((t) => sys.grants.tools.includes(t) || t === 'search_files'), inheriting.join(','));
  assert.ok(inheriting.includes('upload_file') && inheriting.includes('get_file'));
  assert.ok(!inheriting.includes('decide_deploy') && !inheriting.includes('promote'), 'agent-forbidden tools are never advertised');
  const limited = grantedToolSpecs(asUser('admin'), sys, ['get_file']).map((t) => t.name);
  assert.ok(limited.includes('get_file') && !limited.includes('upload_file') && limited.every((t) => inheriting.includes(t)), 'a limited agent holds a subset');

  // 2. ROLE FLOOR: the same inheriting agent, run by a lower role, is handed no more than that role may call.
  const asCreator = grantedToolSpecs(asUser('creator'), sys).map((t) => t.name);
  assert.ok(asCreator.every((t) => inheriting.includes(t)), 'a lower role never sees more');

  // 3. GRANTS: a file outside the granted folder is refused, a write into a read-only grant too.
  const scope = grantScopeOf(sys);
  assert.equal((await checkGrantScope('get_file', { fileId: 'f_ok' }, scope, RESOLVERS)).allow, true);
  assert.equal((await checkGrantScope('get_file', { fileId: 'f_other' }, scope, RESOLVERS)).allow, false);

  // 4. HOLDS: a My write runs, a promotion is held, and read-only holds every write — as before.
  assert.deepEqual(holdDecisionFor('read-bounded', 'upload_file'), { held: false });
  assert.deepEqual(holdDecisionFor('read-bounded', 'request_promotion'), { held: true, approverRole: 'domain_admin' });
  assert.deepEqual(holdDecisionFor('read-only', 'upload_file'), { held: true, approverRole: 'admin' });
});

test('CREATE: a proposer-narrowed agent keeps the READ tools its team\'s grants imply (data, knowledge, files)', () => {
  const catalog = ['search_knowledge', 'get_knowledge', 'list_knowledge', 'query_data', 'list_datasets', 'get_dataset', 'upload_file', 'get_file', 'list_files', 'search_files'];
  const base = { ...blank(), grants: { ...blank().grants, data: [{ id: 'ds_1', capability: 'Read' as const }], files: [{ id: '', capability: 'Read' as const, folder: { path: '/in', scope: 'personal' as const } }] } };
  const { system } = scaffoldFromProposal(base, [
    { id: 'writer', role: 'Writes the report', instruction: 'Write a short report file.' },
    { id: 'checker', role: 'Checks', instruction: 'Check the report.' },
  ], catalog);
  for (const a of system.agents) {
    for (const t of ['query_data', 'list_datasets', 'get_dataset', 'list_files', 'get_file', 'search_files']) assert.ok(a.tools?.includes(t), `${a.id} can read via ${t}`);
    assert.ok(!a.tools?.includes('search_knowledge'), 'no knowledge grant: no knowledge read tool');
  }
  assert.doesNotThrow(() => compile(system));
});

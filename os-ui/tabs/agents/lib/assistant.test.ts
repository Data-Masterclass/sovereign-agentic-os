/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { applyInstruction, scaffoldSystem, parseProposedAgents } from '@tabs/agents/lib/assistant';

const BASE = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants: { tools: [search_knowledge, upload_file] }
agents:
  - { id: supervisor, role: router, agent_md: "# Sup", memory_md: "", members: [writer] }
  - { id: writer, role: writes, agent_md: "# Writer", memory_md: "", tools: [upload_file] }
edges:
  - { from: supervisor, to: writer, type: supervise }
`;

test('"add a research sub-agent that hands off to the writer" mutates the one source', () => {
  const before = parseSystem(BASE);
  const { system, summary } = applyInstruction(before, 'add a research sub-agent that hands off to the writer');

  // A new agent was added under the supervisor...
  const researcher = system.agents.find((a) => /research/i.test(a.id));
  assert.ok(researcher, 'a researcher agent exists');
  assert.ok(system.agents.find((a) => a.id === 'supervisor')!.members!.includes(researcher!.id));
  // ...with a handoff edge to the writer.
  assert.ok(
    system.edges.some((e) => e.from === researcher!.id && e.to === 'writer' && e.type === 'handoff'),
  );
  // It still compiles (identical to the manual path).
  assert.doesNotThrow(() => compile(system));
  assert.match(summary, /research/i);
});

test('the helper never grants a tool the system lacks (narrow-only safe)', () => {
  const before = parseSystem(BASE);
  const { system } = applyInstruction(before, 'add a researcher sub-agent that hands off to the writer');
  const researcher = system.agents.find((a) => /research/i.test(a.id))!;
  // Its tools must be ⊆ system grants, so compile stays clean.
  for (const t of researcher.tools ?? []) assert.ok(before.grants.tools.includes(t));
  assert.doesNotThrow(() => compile(system));
});

test('a handoff is only reported as wired when the target agent actually exists', () => {
  // Finding #5 — applyInstruction must not claim a handoff was wired when the
  // target does not exist (no edge was added).
  const before = parseSystem(BASE);
  const { system, summary } = applyInstruction(before, 'add a research sub-agent that hands off to the ghost');
  const researcher = system.agents.find((a) => /research/i.test(a.id))!;
  // No edge to a non-existent 'ghost' was added...
  assert.ok(!system.edges.some((e) => e.from === researcher.id && e.to === 'ghost'));
  // ...and the summary must NOT falsely claim it hands off to 'ghost'.
  assert.doesNotMatch(summary, /hands off to 'ghost'/);
  // A real target is still wired and reported.
  const ok = applyInstruction(before, 'add a research sub-agent that hands off to the writer');
  const r2 = ok.system.agents.find((a) => /research/i.test(a.id))!;
  assert.ok(ok.system.edges.some((e) => e.from === r2.id && e.to === 'writer' && e.type === 'handoff'));
  assert.match(ok.summary, /hands off to 'writer'/);
});

test('an unrecognised instruction is reported, not silently ignored', () => {
  const before = parseSystem(BASE);
  assert.throws(() => applyInstruction(before, 'make me a sandwich'), /could not turn that into a system edit/i);
});

// --- free-form scaffolder (LLM fallback, stubbed) --------------------------

/** An empty starting system (what a fresh Simple builder session sees). */
const EMPTY = `
system: { name: Untitled system, domain: sales, visibility: Personal }
entrypoint: ""
grants: { tools: [] }
agents: []
`;

/** A stub completer returning a fixed JSON team — deterministic, no network. */
const stub = (json: string) => async () => json;

const FOUR_STEP = JSON.stringify({
  agents: [
    { id: 'pull-campaign-data', role: 'Pulls campaign data', instruction: 'Query the campaign dataset for the period.' },
    { id: 'check-margins', role: 'Checks margins after returns', instruction: 'Compute margin after returns per campaign.' },
    { id: 'score-campaigns', role: 'Scores each campaign against rules', instruction: 'Apply the policy rules and score each campaign.' },
    { id: 'recommend-budget', role: 'Recommends budget changes', instruction: 'Recommend budget changes from the scores.' },
  ],
});

test('a free-form description yields a valid linear multi-agent team', async () => {
  const before = parseSystem(EMPTY);
  const { system, summary } = await scaffoldSystem(
    before,
    'a team that pulls campaign data, checks margins after returns, scores each campaign, and recommends budget changes',
    { complete: stub(FOUR_STEP) },
  );

  // >= 2 agents, in order, with per-agent instructions.
  assert.ok(system.agents.length >= 2);
  assert.equal(system.agents[0].id, 'pull-campaign-data');
  for (const a of system.agents) assert.ok(a.agent_md.trim().length > 0, `agent ${a.id} has instructions`);

  // Linear chain: consecutive handoff edges, first agent is the entrypoint.
  assert.equal(system.entrypoint, system.agents[0].id);
  for (let i = 0; i < system.agents.length - 1; i++) {
    assert.ok(
      system.edges.some((e) => e.from === system.agents[i].id && e.to === system.agents[i + 1].id && e.type === 'handoff'),
      `handoff ${system.agents[i].id} -> ${system.agents[i + 1].id}`,
    );
  }

  // Passes schema + compiler validation (identical to the manual builder path).
  assert.doesNotThrow(() => parseSystem(serializeSystem(system)));
  assert.doesNotThrow(() => compile(system));
  assert.match(summary, /team/i);
});

test('scaffold tools come from suggest-tools and never exceed the role floor', async () => {
  const before = parseSystem(EMPTY);
  // The caller may ONLY grant search_knowledge (a tight role floor).
  const floor = ['search_knowledge'];
  const { system } = await scaffoldSystem(before, 'pull data, analyze, and report', {
    complete: stub(FOUR_STEP),
    catalog: floor,
  });
  // Every granted tool (and every per-agent tool) must be within the floor.
  for (const t of system.grants.tools) assert.ok(floor.includes(t), `grant ${t} within floor`);
  for (const a of system.agents) for (const t of a.tools ?? []) assert.ok(floor.includes(t), `${a.id} tool ${t} within floor`);
  // And per-agent tools stay a subset of grants ⇒ compile is clean (narrow-only).
  assert.doesNotThrow(() => compile(system));
});

test('describing again REPLACES the scaffold (no duplicate agents)', async () => {
  const before = parseSystem(EMPTY);
  const first = await scaffoldSystem(before, 'anything', { complete: stub(FOUR_STEP) });
  const second = await scaffoldSystem(first.system, 'anything again', { complete: stub(FOUR_STEP) });
  assert.equal(second.system.agents.length, 4); // not 8
});

test('a malformed LLM output is rejected, never written as an invalid system', async () => {
  const before = parseSystem(EMPTY);
  // Garbage / single-agent / empty proposals must all be rejected.
  await assert.rejects(() => scaffoldSystem(before, 'x', { complete: stub('not json at all') }), /could not turn that description/i);
  await assert.rejects(() => scaffoldSystem(before, 'x', { complete: stub('{"agents":[]}') }), /could not turn that description/i);
  await assert.rejects(
    () => scaffoldSystem(before, 'x', { complete: stub(JSON.stringify({ agents: [{ id: 'solo', role: 'r', instruction: 'i' }] })) }),
    /could not turn that description/i,
  );
});

test('parseProposedAgents repairs ids and drops empty steps', () => {
  const agents = parseProposedAgents(JSON.stringify({
    agents: [
      { id: 'Pull Data!!', role: 'Pulls', instruction: 'do it' },
      { role: '', instruction: '' }, // empty — dropped
      { id: 'pull-data', role: 'Also pulls', instruction: 'again' }, // id collides ⇒ de-duped
    ],
  }));
  assert.equal(agents.length, 2);
  assert.equal(agents[0].id, 'pull-data');
  assert.notEqual(agents[1].id, agents[0].id); // unique
});

// --- F0: a proposed team must BUILD and RUN ---------------------------------------------------
//
// The proposer used to write every hand-off as `when: "<role> complete"`. That is a label, not a
// `when` expression, so the graph builder rejected it and a team accepted from "Proposed team"
// could be neither built nor run.

import { parseWhen } from '@tabs/agents/lib/engine/when';
import { buildGraph } from '@tabs/agents/lib/engine/build-graph';

function buildable(system: ReturnType<typeof parseSystem>) {
  return buildGraph(compile(system), {
    llm: async () => ({ content: '', toolCalls: [] }),
    toolSpecsFor: () => [],
    callTool: async () => ({ text: '', isError: false }),
    preamble: '',
    reasoningModel: 'r',
    execModel: 'e',
  });
}

test('F0: a proposed team writes UNGUARDED hand-offs — every edge is a valid `when` or has none — and the graph builds clean', async () => {
  const before = parseSystem(BASE);
  const { system } = await scaffoldSystem(before, 'pull data, check margins, score, recommend', { complete: stub(FOUR_STEP) });
  assert.ok(system.edges.length >= 2);
  for (const e of system.edges) {
    assert.equal(e.when, undefined, `${e.from} → ${e.to} is a plain "then" — it carries no condition`);
    if (e.when !== undefined) assert.doesNotThrow(() => parseWhen(e.when!));
  }
  // The stored form (what the builder commits) round-trips without a `when` either.
  const stored = parseSystem(serializeSystem(system));
  assert.ok(stored.edges.every((e) => e.when === undefined));
  const built = buildable(stored);
  assert.deepEqual(built.warnings, [], 'nothing to warn about');
  assert.deepEqual(built.agents, system.agents.map((a) => a.id));
});

test('F0: "add a research sub-agent that hands off to the writer" writes an unguarded hand-off that builds', () => {
  const { system } = applyInstruction(parseSystem(BASE), 'add a research sub-agent that hands off to the writer');
  const edge = system.edges.find((e) => e.type === 'handoff' && e.to === 'writer')!;
  assert.equal(edge.when, undefined);
  assert.doesNotThrow(() => buildable(system));
});

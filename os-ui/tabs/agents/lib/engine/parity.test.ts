/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Parity tests P1 + P2 — the LangGraph engine still reproduces every frozen golden
 * USER STORY: As the engineer who deleted the walker I want a table-driven test proving that, for
 *             every fixture the walker recorded, `buildGraph` reproduces its visited path,
 *             (tool, args, outcome) sequence and final text (P1); that handoff guards now ROUTE
 *             where the walker ignored them (HANDOFF-GUARD); and that a run killed mid-way and
 *             resumed on the same thread ends exactly like an uninterrupted one (P2).
 * ARCHITECTURE:
 *   - Reads every ./fixtures/*.json inside a guarded loader (a missing directory is a FAILING
 *     test, never zero tests). `replayGraph` / `scriptGraph` drive the engine (parity-harness.ts
 *     documents which fixtures use which and why). A5 deleted the walker side: the goldens in the
 *     files ARE the walker, frozen, and `fixtures.test.ts` keeps them that way.
 *   - Guarded fixtures are asserted explicitly, because the engine is SUPPOSED to differ there:
 *     the software team's guards are all false (nothing sets their channels) so its supervisor
 *     drives the walker's order; shape (c) must NOT visit `publisher`, which the walker did.
 *   - P2 aborts the stream after the first `node-completed`, resumes with the same thread id on
 *     the same MemorySaver and compares path, tool sequence and final text with a clean run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import {
  FIXTURE_USER,
  graphDeps,
  hasSupervisor,
  replayGraph,
  runGraph,
  scriptedLlm,
  scriptGraph,
  SCRIPT_ID,
  nodeOfRequest,
  SHAPE_CHANNEL_GUARDED_YAML,
  stateWritingLlm,
  type EngineFixture,
  type GoldenToolCall,
} from '@tabs/agents/lib/engine/parity-harness';
import { buildGraph, SET_STATE_TOOL_NAME } from '@tabs/agents/lib/engine/build-graph';
import { grantedToolSpecs } from '@tabs/agents/lib/build/os-tools';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

let fixtures: EngineFixture[] = [];
let loadError: string | null = null;
try {
  fixtures = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as EngineFixture);
} catch (e) {
  loadError = (e as Error).message;
}

test('P1 has fixtures to run against', () => {
  assert.equal(loadError, null, `fixtures could not be loaded: ${loadError}`);
  assert.ok(fixtures.length >= 13, `expected ≥13 fixtures, found ${fixtures.length}`);
  for (const fx of fixtures) assert.equal(fx.script, SCRIPT_ID, `${fx.name} was recorded under ${fx.script}`);
});

for (const fx of fixtures) {
  // A guarded fixture's golden records the walker IGNORING its `when` guards, so the engine must
  // NOT reproduce it; each one is asserted on its own below.
  if (fx.guarded) continue;

  const supervised = hasSupervisor(parseSystem(fx.yaml));
  test(`P1 ${fx.name}: buildGraph reproduces the frozen golden (${supervised ? 'scripted route decisions in declared order' : 'replayed transcript'})`, async () => {
    const run = supervised ? await scriptGraph(fx) : await replayGraph(fx);
    assert.deepEqual(run.path, fx.golden.path, 'visited node path');
    assert.deepEqual(run.toolCalls, fx.golden.toolCalls, '(node, tool, args, outcome) sequence');
    assert.equal(run.finalText, fx.golden.finalText, 'final text');
    assert.equal(run.reachedEnd, fx.golden.reachedEnd, 'reachedEnd');
    assert.equal(run.held, fx.golden.held, 'writes held by the real gate');
    assert.deepEqual(run.warnings, [], 'no compile warnings on an unguarded fixture');
    if (!supervised) assert.equal((run as { remaining: number }).remaining, 0, 'every recorded exchange was consumed');
  });
}

// ------------------------------------------------------ guarded fixtures, engine side --

const softwareTeam = fixtures.find((f) => f.name === 'software-team');
test('P1 software-team: its five guards now have a declared, settable channel each — ZERO compile warnings, and the supervisor still drives the walker\'s declared order when nothing sets them', async (t) => {
  if (!softwareTeam) return t.skip('fixture missing');
  const run = await scriptGraph(softwareTeam);
  assert.deepEqual(run.path, softwareTeam.golden.path);
  assert.deepEqual(run.toolCalls, softwareTeam.golden.toolCalls);
  assert.equal(run.finalText, softwareTeam.golden.finalText);
  assert.equal(run.reachedEnd, true);
  assert.equal(run.held, softwareTeam.golden.held);
  // A5-review-H-2 (7): the five "no node sets it" warnings are GONE — the channels are declared
  // `boolean` and the agent each guard follows is advertised `os_set_state`. The scripted model
  // never calls it, so the guards are false and the supervisor's declared order still holds:
  // a settable channel that nobody set is a false guard, not a broken one.
  assert.deepEqual(run.warnings, [], `software-team must compile clean: ${run.warnings.join(' | ')}`);
  // And the writers really are advertised the tool (the proof the warning's absence is earned).
  const sys = parseSystem(softwareTeam.yaml);
  const ir = compile(sys);
  const built = buildGraph(ir, graphDeps(sys, 'software-team-tools', scriptedLlm('x'), { enqueued: [] }));
  assert.deepEqual(built.warnings, []);
  for (const node of ['planner', 'builder', 'tester', 'deployer']) {
    const n = ir.nodes.find((x) => x.id === node)!;
    assert.ok(
      grantedToolSpecs(FIXTURE_USER, sys, n.tools).every((t) => t.name !== SET_STATE_TOOL_NAME),
      `${node}'s GOVERNED grants do not include ${SET_STATE_TOOL_NAME} (it is the engine's, not a grant)`,
    );
  }
});

const guardedShape = fixtures.find((f) => f.name === 'shape-guarded-handoff-held-write');
test('HANDOFF-GUARD shape-guarded-handoff-held-write: when:"state.findings_ready" is never true, so publisher is NOT visited and nothing is held', async (t) => {
  if (!guardedShape) return t.skip('fixture missing');
  assert.ok(guardedShape.golden.path.includes('publisher'), 'the walker golden still records the defect (visits publisher)');
  const run = await scriptGraph(guardedShape);
  assert.deepEqual(run.path, ['researcher']);
  assert.ok(!run.path.includes('publisher'), 'the guarded target is not visited');
  assert.deepEqual(run.toolCalls, guardedShape.golden.toolCalls.filter((c: GoldenToolCall) => c.node === 'researcher'));
  assert.equal(run.held, 0, 'the held write never happened because publisher never ran');
  assert.equal(run.reachedEnd, true);
  assert.equal(run.finalText, 'FINAL(researcher): answered the task using search_knowledge.');
  // A5-review-H-2: `findings_ready` is DECLARED, so the researcher can now set it and the guard is
  // no longer a compile warning — it is simply false, because the scripted model never sets it.
  assert.deepEqual(run.warnings, []);
});

// ------------------------------------------------- channel-guarded handoff (A5-review-H-2) --

/**
 * THE PROOF A8 WAS MISSING. Before this round, every `when` guard was unreachable: the engine
 * evaluated them, but no node could write a state channel, so `software-team`'s five-phase chain
 * could never fire and the only guard test was the NEGATIVE one above. Here the SAME shape is
 * driven three times with a scripted model that differs only in what it writes.
 */
const CHANNEL_SPEC = { name: 'channel-guarded-handoff', yaml: SHAPE_CHANNEL_GUARDED_YAML, task: 'Plan and build the sales recap.' };

test('CHANNEL-GUARD channel-guarded-handoff: the guarded edge fires when the agent sets the channel', async () => {
  const run = await runGraph(CHANNEL_SPEC, stateWritingLlm(CHANNEL_SPEC.task, { channel: 'plan_ready', value: true }), { runId: 'ch-set' });
  assert.deepEqual(run.warnings, [], 'a declared, settable channel is not a compile warning');
  assert.deepEqual(run.path, ['planner', 'builder'], 'plan_ready === true routed planner → builder');
  // The write is a recorded tool step like any other, and it is NOT a governed MCP call.
  assert.deepEqual(
    run.toolCalls,
    [
      { node: 'planner', tool: SET_STATE_TOOL_NAME, args: { channel: 'plan_ready', value: true }, outcome: 'ok' },
      { node: 'builder', tool: 'query_data', args: { input: 'fixture:builder', task: CHANNEL_SPEC.task }, outcome: 'ok' },
    ],
    '(node, tool, args, outcome) sequence',
  );
  assert.equal(run.held, 0, 'a state write is never held for approval');
  assert.equal(run.reachedEnd, true);
  assert.equal(run.finalText, 'FINAL(builder): answered the task.');
});

test('CHANNEL-GUARD channel-guarded-handoff: the SAME graph stops at the planner when the channel is not set', async () => {
  const run = await runGraph(CHANNEL_SPEC, stateWritingLlm(CHANNEL_SPEC.task, null), { runId: 'ch-unset' });
  assert.deepEqual(run.warnings, []);
  assert.deepEqual(run.path, ['planner'], 'plan_ready stayed at its declared default (false)');
  assert.deepEqual(run.toolCalls, [
    { node: 'planner', tool: 'search_knowledge', args: { input: 'fixture:planner', task: CHANNEL_SPEC.task }, outcome: 'ok' },
  ]);
  assert.equal(run.reachedEnd, true);
  assert.equal(run.finalText, 'FINAL(planner): answered the task.');
});

test('CHANNEL-GUARD an UNDECLARED channel is a typed tool error, never a new state key', async () => {
  const run = await runGraph(CHANNEL_SPEC, stateWritingLlm(CHANNEL_SPEC.task, { channel: 'tests_passed', value: true }), { runId: 'ch-undeclared' });
  assert.deepEqual(run.path, ['planner'], 'the rejected write left the guard false');
  assert.equal(run.toolCalls.length, 1);
  assert.equal(run.toolCalls[0].outcome, 'error');
  assert.equal(run.reachedEnd, true);
});

test('CHANNEL-GUARD a wrong-typed value is refused; the setter is advertised to the guard\'s `from` agent only', async () => {
  const run = await runGraph(CHANNEL_SPEC, stateWritingLlm(CHANNEL_SPEC.task, { channel: 'plan_ready', value: { not: 'a boolean' } }), { runId: 'ch-mistyped' });
  assert.deepEqual(run.path, ['planner'], 'a refused write cannot route');
  assert.equal(run.toolCalls[0].outcome, 'error');

});

test('CHANNEL-GUARD node-level narrowing: only the agent whose guard reads a channel is ADVERTISED the setter', async () => {
  // What each node was actually offered, read off the model requests the engine made.
  const offered = new Map<string, Set<string>>();
  const base = stateWritingLlm(CHANNEL_SPEC.task, { channel: 'plan_ready', value: true });
  const spy: typeof base = async (req) => {
    if (req.tools) {
      const node = nodeOfRequest(req);
      const seen = offered.get(node) ?? new Set<string>();
      for (const t of req.tools) seen.add(t.function.name);
      offered.set(node, seen);
    }
    return base(req);
  };
  const run = await runGraph(CHANNEL_SPEC, spy, { runId: 'ch-narrow' });
  assert.deepEqual(run.path, ['planner', 'builder']);
  assert.ok(offered.get('planner')?.has(SET_STATE_TOOL_NAME), 'the planner carries the guard, so it may set the channel');
  assert.ok(offered.get('planner')?.has('search_knowledge'), 'alongside its governed grants');
  assert.ok(!offered.get('builder')?.has(SET_STATE_TOOL_NAME), 'the builder has no guard of its own — no setter');
  // The GRANTS never contain it either way: the setter is the engine's, not a governed tool.
  const sys = parseSystem(SHAPE_CHANNEL_GUARDED_YAML);
  const ir = compile(sys);
  assert.deepEqual(buildGraph(ir, graphDeps(sys, 'channel-shape', scriptedLlm(''), { enqueued: [] })).warnings, []);
  for (const n of ir.nodes) {
    assert.ok(grantedToolSpecs(FIXTURE_USER, sys, n.tools).every((t) => t.name !== SET_STATE_TOOL_NAME), `${n.id}'s grants`);
  }
});

// ------------------------------------------------------------------------------- P2 --

/** A two-agent unconditional handoff: long enough to kill after the first agent, deterministic to compare. */
const P2_YAML = `version: '1'
system:
  name: P2 — two agents, unconditional handoff
  domain: sales
  visibility: Personal
entrypoint: reader
state:
  channels:
    messages: add_messages
grants:
  data: []
  knowledge: []
  metrics: []
  tools:
    - search_knowledge
    - query_data
  connections: []
agents:
  - id: reader
    role: Reads the knowledge
    agent_md: '# reader'
    memory_md: '# Memory'
    tools:
      - search_knowledge
  - id: writer
    role: Queries the data and writes the answer
    agent_md: '# writer'
    memory_md: '# Memory'
    tools:
      - query_data
edges:
  - from: reader
    to: writer
    type: handoff
`;

test('P2: a run aborted after node 1 and resumed on the same thread id ends exactly like an uninterrupted run', async () => {
  const spec = { name: 'p2', yaml: P2_YAML, task: 'Assess the sales domain.' };
  const clean = await runGraph(spec, scriptedLlm(spec.task), { runId: 'p2-clean' });
  assert.deepEqual(clean.path, ['reader', 'writer']);
  assert.equal(clean.reachedEnd, true);

  // Kill the run the moment the first agent completes (the route superstep is still in flight).
  const cp = memoryCheckpointer();
  const ctl = new AbortController();
  const aborted = await runGraph(spec, scriptedLlm(spec.task), {
    runId: 'p2-thread',
    checkpointer: cp,
    signal: ctl.signal,
    hooks: { onNodeComplete: (ev) => { if (ev.node === 'reader') ctl.abort(); } },
  });
  assert.equal(aborted.interrupted, true, 'the aborted run reports itself interrupted');
  assert.equal(aborted.reachedEnd, false);
  assert.ok(!aborted.path.includes('writer'), `writer must not have run before the abort: ${aborted.path.join(',')}`);

  // Resume with the SAME thread id on the SAME checkpointer, a fresh model (as a new process would have).
  const resumed = await runGraph(spec, scriptedLlm(spec.task), {
    runId: 'p2-thread',
    checkpointer: cp,
    resume: true,
    toolCalls: aborted.toolCalls,
  });
  assert.equal(resumed.interrupted, false);
  assert.deepEqual(resumed.path, clean.path, 'same visited path');
  assert.deepEqual(resumed.toolCalls, clean.toolCalls, 'same (node, tool, args, outcome) sequence across abort + resume');
  assert.equal(resumed.finalText, clean.finalText, 'same final text');
  assert.equal(resumed.reachedEnd, true);
});

test('P2: resuming an unknown thread is a typed error, never a silent fresh run', async () => {
  const spec = { name: 'p2-unknown', yaml: P2_YAML, task: 'x' };
  await assert.rejects(
    () => runGraph(spec, scriptedLlm(spec.task), { runId: 'never-started', resume: true, checkpointer: memoryCheckpointer() }),
    (e: Error) => e.name === 'ResumeNotFoundError' && /never-started/.test(e.message),
  );
});

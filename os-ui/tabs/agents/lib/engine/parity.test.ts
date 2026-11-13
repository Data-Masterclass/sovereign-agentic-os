/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Parity tests P1 + P2 — the old walker and the LangGraph engine agree on every golden
 * USER STORY: As the engine-rebuild engineer I want a table-driven test proving that, for every
 *             fixture, `buildGraph` reproduces the walker's visited path, (tool, args, outcome)
 *             sequence and final text (P1); that handoff guards now ROUTE where the walker ignored
 *             them (HANDOFF-GUARD, flipped from `todo` in A1); and that a run killed mid-way and
 *             resumed on the same thread ends exactly like an uninterrupted one (P2).
 * ARCHITECTURE:
 *   - Reads every ./fixtures/*.json inside a guarded loader (a missing directory is a FAILING
 *     test, never zero tests). `replayWalker` drives the walker; `replayGraph` / `scriptGraph`
 *     drive the engine (parity-harness.ts documents which fixtures use which and why).
 *   - Guarded fixtures: the walker side stays excluded (it ignores guards). The engine side is
 *     asserted explicitly: the software team's guards are all false (nothing sets their channels)
 *     so its supervisor drives the walker's order; shape (c) must NOT visit `publisher`.
 *   - P2 aborts the stream after the first `node-completed`, resumes with the same thread id on
 *     the same MemorySaver and compares path, tool sequence and final text with a clean run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import {
  hasSupervisor,
  replayGraph,
  replayWalker,
  runGraph,
  scriptedLlm,
  scriptGraph,
  SCRIPT_ID,
  type EngineFixture,
  type GoldenToolCall,
} from '@tabs/agents/lib/engine/parity-harness';
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
  if (fx.guarded) {
    test.todo(`P1 ${fx.name} [walker]: excluded from P1 (guarded) — the walker ignores its \`when\` guards`);
    continue;
  }

  test(`P1 ${fx.name} [walker]: replayed transcript reproduces the golden path, tool sequence and final text`, async () => {
    const run = await replayWalker(fx);
    assert.deepEqual(run.path, fx.golden.path, 'visited node path');
    assert.deepEqual(run.toolCalls, fx.golden.toolCalls, '(node, tool, args, outcome) sequence');
    assert.equal(run.finalText, fx.golden.finalText, 'final text');
    assert.equal(run.reachedEnd, fx.golden.reachedEnd, 'reachedEnd');
    assert.equal(run.held, fx.golden.held, 'writes held by the real gate');
    assert.equal(run.remaining, 0, 'every recorded exchange was consumed');
  });

  const supervised = hasSupervisor(parseSystem(fx.yaml));
  test(`P1 ${fx.name} [langgraph]: buildGraph reproduces the same golden (${supervised ? 'scripted route decisions in declared order' : 'replayed transcript'})`, async () => {
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
test('P1 software-team [langgraph]: every guard is false (no node sets plan_ready/committed/…), so the supervisor drives the walker\'s declared order — and each guard is a compile warning', async (t) => {
  if (!softwareTeam) return t.skip('fixture missing');
  const run = await scriptGraph(softwareTeam);
  assert.deepEqual(run.path, softwareTeam.golden.path);
  assert.deepEqual(run.toolCalls, softwareTeam.golden.toolCalls);
  assert.equal(run.finalText, softwareTeam.golden.finalText);
  assert.equal(run.reachedEnd, true);
  assert.equal(run.held, softwareTeam.golden.held);
  for (const ch of ['plan_ready', 'committed', 'tests_failed', 'tests_passed', 'reported']) {
    assert.ok(run.warnings.some((w) => w.includes(`'${ch}'`)), `warning names ${ch}: ${run.warnings.join(' | ')}`);
  }
});

const guardedShape = fixtures.find((f) => f.name === 'shape-guarded-handoff-held-write');
test('HANDOFF-GUARD shape-guarded-handoff-held-write [langgraph]: when:"state.findings_ready" is never true, so publisher is NOT visited and nothing is held', async (t) => {
  if (!guardedShape) return t.skip('fixture missing');
  assert.ok(guardedShape.golden.path.includes('publisher'), 'the walker golden still records the defect (visits publisher)');
  const run = await scriptGraph(guardedShape);
  assert.deepEqual(run.path, ['researcher']);
  assert.ok(!run.path.includes('publisher'), 'the guarded target is not visited');
  assert.deepEqual(run.toolCalls, guardedShape.golden.toolCalls.filter((c: GoldenToolCall) => c.node === 'researcher'));
  assert.equal(run.held, 0, 'the held write never happened because publisher never ran');
  assert.equal(run.reachedEnd, true);
  assert.equal(run.finalText, 'FINAL(researcher): answered the task using search_knowledge.');
  assert.equal(run.warnings.length, 1);
  assert.match(run.warnings[0], /findings_ready/);
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

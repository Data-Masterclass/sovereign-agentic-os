/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The agent NODE layer — handoff material, the Context Librarian, node status
 * USER STORY: As the engineer who replaced the walker with a real StateGraph I want the parts of
 *             the old executor the graph still USES to keep their own tests: what a downstream
 *             agent is handed, when relevance curation engages (and when it must not), how a
 *             node's outcome is classified, and that the seeded team can never approve a deploy.
 * ARCHITECTURE:
 *   - A5 deleted this file's walker tests along with `runAgenticGraph` and `nodeOrder`. The graph's
 *     own behaviour (visit order, supervisor decisions, guards, budget, events, the node tool
 *     gate) is tested in `engine/build-graph.test.ts` and `engine/parity.test.ts`; duplicating it
 *     here through a deleted walk would have been theatre.
 *   - What is tested here is tested DIRECTLY, with no graph in the way: `handoffBlock` /
 *     `nodeSystem` (what the next agent reads), `curatePredecessor` (the Librarian, including the
 *     offline-hash guard that must NOT curate over semantically empty vectors), `nodeStatus` and
 *     `classifyStepError` (error ≠ denial), and the DEPLOY GATE over the real role floor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { listToolsForRole, toolsForTab } from '@core/mcp/server';
import { SOFTWARE_TEAM_YAML } from '@tabs/agents/lib/software-team';
import {
  boundInput,
  classifyStepError,
  curatePredecessor,
  handoffBlock,
  nodeStatus,
  nodeSystem,
  renderUserTurn,
  type AgenticGraphDeps,
  type HandoffEntry,
} from '@tabs/agents/lib/build/agentic-graph';
import type { AgenticResult, AgenticStep } from '@core/runtime/agentic';

const IR = compile(parseSystem(SOFTWARE_TEAM_YAML));
const NODE = (id: string) => IR.nodes.find((n) => n.id === id)!;

function step(over: Partial<AgenticStep> = {}): AgenticStep {
  return { tool: 'query_data', args: {}, result: 'ok', isError: false, ...over } as AgenticStep;
}

function baseDeps(over: Partial<AgenticGraphDeps> = {}): AgenticGraphDeps {
  return {
    llm: async () => ({ content: '', toolCalls: [] }),
    toolSpecsFor: () => [],
    callTool: async () => ({ text: 'ok', isError: false }),
    preamble: 'OS RULES + software context',
    reasoningModel: 'sovereign-reasoning',
    execModel: 'sovereign-default',
    maxIterations: 2,
    ...over,
  };
}

// --- what the next agent is handed -------------------------------------------

test('handoffBlock carries the prior node\'s STRUCTURED output, not just its narration', () => {
  const rows = JSON.stringify([{ campaign: 'alpha', roas: 3.2 }, { campaign: 'beta', roas: 1.1 }]);
  const block = handoffBlock('analyst', 'Alpha is the best performer.', [step({ tool: 'query_data', result: rows })]);
  assert.match(block, /## analyst/);
  assert.match(block, /Alpha is the best performer\./, 'the narration is there');
  assert.match(block, /data produced \(use this directly\)/, 'and the material is labelled as usable');
  assert.match(block, /alpha/, 'the actual rows reached the block');
});

test('handoffBlock names the tools that did NOT return data, so the next agent knows what is missing', () => {
  const block = handoffBlock('analyst', 'Partial.', [step({ tool: 'query_metric', result: 'forbidden', isError: true })]);
  assert.match(block, /tools that did NOT return data: query_metric/);
});

test('handoff: a 40-row scorecard passes to the downstream node WITHOUT row truncation', () => {
  const rows = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ campaign: `campaign_${i}`, roas: i })));
  const block = handoffBlock('analyst', 'Scored every campaign.', [step({ tool: 'query_data', result: rows })]);
  for (const i of [0, 17, 39]) assert.match(block, new RegExp(`campaign_${i}\\b`), `row ${i} survived`);
});

test('nodeSystem composes preamble + role + memory + the team progress, newest entry last', () => {
  const transcript: HandoffEntry[] = [
    { node: 'planner', block: '## planner\nPlanned it.' },
    { node: 'analyst', block: '## analyst\nAnalysed it.' },
  ];
  const sys = nodeSystem('OS RULES', NODE('builder'), transcript);
  assert.match(sys, /^OS RULES/);
  assert.match(sys, /--- YOUR ROLE IN THE TEAM: builder ---/);
  assert.match(sys, /TEAM PROGRESS SO FAR/);
  assert.ok(sys.indexOf('## planner') < sys.indexOf('## analyst'), 'the most recent entry is last');
});

test('nodeSystem with no transcript omits the progress section entirely (a first node reads no handoff)', () => {
  const sys = nodeSystem('OS RULES', NODE('orchestrator'), []);
  assert.doesNotMatch(sys, /TEAM PROGRESS SO FAR/);
});

test('the captured drill-down `input` is the system context plus the user turn, honestly elided', () => {
  const long = 'x'.repeat(20_000);
  const input = boundInput(long + renderUserTurn([{ role: 'user', content: 'build a todo app' }]));
  assert.ok(input.length < long.length, 'the capture is bounded');
  assert.match(input, /elided|truncated|…/i, 'and says so rather than pretending to be whole');
  const short = boundInput('ctx' + renderUserTurn([{ role: 'user', content: 'build a todo app' }]));
  assert.match(short, /--- USER TURN ---\nbuild a todo app/);
});

// --- CONTEXT LIBRARIAN: relevance-curated handoff + offline-hash fallback guard ---

/** A deterministic keyword embedder: cosine is high when texts share a vocab word. */
function keywordEmbed() {
  const vocab = ['scorecard', 'campaign', 'roas', 'weather', 'recipe'];
  let calls = 0;
  const embed = async (texts: string[]) => {
    calls += 1;
    return texts.map((t) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));
  };
  return { embed, calls: () => calls };
}

/** A predecessor that produced one RELEVANT scorecard and one big irrelevant blob. */
function overBudgetPredecessor(): HandoffEntry {
  const scorecard = JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ campaign: `campaign_${i}`, roas: i, note: 'scorecard' })),
  );
  const weather = `weather recipe ${'w'.repeat(20_000)}`;
  const steps = [
    step({ tool: 'query_scorecard', result: scorecard }),
    step({ tool: 'get_weather', result: weather }),
  ];
  return { node: 'orchestrator', block: handoffBlock('orchestrator', 'Gathered both.', steps), finalText: 'Gathered both.', steps };
}

test('handoff (Librarian): with a live embedder, the RELEVANT predecessor output is kept and irrelevant filler dropped', async () => {
  const { embed, calls } = keywordEmbed();
  const before = [overBudgetPredecessor()];
  const after = await curatePredecessor(
    before,
    NODE('builder'),
    'recommend budget per campaign from the scorecard roas',
    // small budget → the two big outputs force the handoff over the ceiling
    baseDeps({ budget: 2_000, embed, embedSource: () => 'litellm' }),
  );
  assert.ok(calls() > 0, 'the Librarian embedded the over-budget handoff');
  const block = after[after.length - 1].block;
  assert.notEqual(block, before[0].block, 'the predecessor entry was re-rendered');
  assert.match(block, /campaign_0/, 'the relevant scorecard survived curation');
  assert.ok(block.length < before[0].block.length, 'and the irrelevant blob did not');
});

test('handoff (Librarian): offline-hash source FALLS BACK to the keepRows path (no relevance curation)', async () => {
  const { embed, calls } = keywordEmbed();
  const before = [overBudgetPredecessor()];
  const after = await curatePredecessor(
    before,
    NODE('builder'),
    'recommend campaigns',
    baseDeps({ budget: 2_000, embed, embedSource: () => 'offline-hash' }),
  );
  // The guard short-circuits BEFORE embedding, so the embedder is never called.
  assert.equal(calls(), 0, 'offline-hash source skips relevance curation entirely');
  assert.deepEqual(after, before, 'the deterministic keepRows handoff is handed on untouched');
  assert.match(after[0].block, /campaign_0/, 'keepRows handoff still delivers the scorecard');
});

test('handoff (Librarian): with NO embedder at all the transcript is handed on untouched', async () => {
  const before = [overBudgetPredecessor()];
  assert.deepEqual(await curatePredecessor(before, NODE('builder'), 'anything', baseDeps()), before);
});

// --- DEPLOY GATE -------------------------------------------------------------

test('DEPLOY GATE: the seeded team never grants decide_deploy, and a creator is never offered it', () => {
  const sys = parseSystem(SOFTWARE_TEAM_YAML);
  // (a) The system grants exclude the go-live approval tool by construction.
  assert.ok(!sys.grants.tools.includes('decide_deploy'), 'decide_deploy is NOT granted to the team');
  // (b) The real per-user role floor: a creator's software tools exclude the
  //     elevated set (decide_deploy/promote/delete) but include request_deploy.
  const creatorTools = new Set(listToolsForRole('creator', toolsForTab('software')).map((t) => t.name));
  assert.ok(!creatorTools.has('decide_deploy'), 'a creator is never offered decide_deploy');
  assert.ok(creatorTools.has('request_deploy'), 'a creator CAN request a deploy');
  // A creator builds via the STAGED governed flow (Design→Build→Test), not the raw
  // `commit` — which is now Developer mode (Builder+). This is the design-before-build
  // governance: a creator cannot bypass the staged gate by writing files directly.
  assert.ok(
    creatorTools.has('create_software') && creatorTools.has('design_software') && creatorTools.has('build_software'),
    'a creator can build via the staged Define→Design→Build tools',
  );
  assert.ok(!creatorTools.has('commit'), 'a creator is NOT offered the raw commit (Developer mode is Builder+)');
  // (c) A builder, by contrast, CAN decide AND use Developer-mode commit — proving the floor is role-scoped.
  const builderTools = new Set(listToolsForRole('builder', toolsForTab('software')).map((t) => t.name));
  assert.ok(builderTools.has('decide_deploy'), 'a builder CAN approve a deploy');
  assert.ok(builderTools.has('commit'), 'a builder CAN use Developer-mode commit');
});

// --- error vs denial: classify a step + reflect the right node status --------

test('classifyStepError: policy codes are policy; exec/Trino errors are exec', () => {
  for (const code of ['forbidden', 'held', 'not_found', 'rejected']) {
    assert.equal(classifyStepError(JSON.stringify({ error: { code } })), 'policy', code);
  }
  // A raw engine failure carries no typed envelope, and an untyped code is not a denial.
  for (const text of ['TrinoQueryError: line 1:8 mismatched input', 'ECONNREFUSED', '{"error":{"code":"internal"}}']) {
    assert.equal(classifyStepError(text), 'exec', text);
  }
});

test('node status: a Trino-error step → "error"; an OPA-deny step → "denied"; a clean run → "ok"', () => {
  const result = (steps: AgenticStep[]): AgenticResult => ({ plan: '', steps, finalText: 'done', iterations: 1, toolCallingSupported: true });
  assert.equal(nodeStatus(result([step()])), 'ok');
  assert.equal(nodeStatus(result([step({ result: 'TrinoQueryError: bad sql', isError: true })])), 'error');
  const denied = JSON.stringify({ error: { code: 'forbidden' } });
  assert.equal(nodeStatus(result([step({ result: denied, isError: true })])), 'denied');
  // A denial outranks an execution error: the governance fact is the one to surface.
  assert.equal(nodeStatus(result([step({ result: 'TrinoQueryError', isError: true }), step({ result: denied, isError: true })])), 'denied');
  assert.equal(nodeStatus(result([step()]), 'it threw'), 'failed');
});

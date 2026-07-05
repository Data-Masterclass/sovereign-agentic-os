/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { SOFTWARE_TEAM_YAML } from '../software-team.ts';
import { runNode, type AgenticGraphDeps } from './agentic-graph.ts';
import type { LlmCall, LlmCompletion, ToolSpec } from '@/lib/assistant/agentic';
import {
  preRoute,
  postRoute,
  extractSignals,
  stripControlTags,
  classifyTeamError,
  getSession,
  saveSession,
  resetSession,
  newSession,
  ROLE_BY_PHASE,
  isApproval,
  isShip,
  type TeamSession,
} from './phase-router.ts';

const IR = compile(parseSystem(SOFTWARE_TEAM_YAML));

const sess = (over: Partial<TeamSession> = {}): TeamSession => ({ ...newSession(), ...over });

// ------------------------------------------------------------- Routing (pure) --

test('a vague brief starts in INTAKE and runs the planner — the builder never runs first', () => {
  const { phase, role } = preRoute(sess({ phase: 'intake' }), 'build me something');
  assert.equal(phase, 'intake');
  assert.equal(role, 'planner');
  assert.notEqual(role, 'builder'); // ask-before-build is structural
});

test('INTAKE stays intake while the planner asks questions; advances to PLAN on a plan', () => {
  const asking = extractSignals({ plan: '', steps: [], finalText: '1. Who uses it? [[QUESTIONS]]', iterations: 0, toolCallingSupported: true });
  assert.equal(asking.planReady, false);
  assert.equal(postRoute('intake', asking), 'intake');

  const planned = extractSignals({ plan: '', steps: [], finalText: 'Plan: routes /, table renewals. [[PLAN_READY]]', iterations: 0, toolCallingSupported: true });
  assert.equal(planned.planReady, true);
  assert.equal(postRoute('intake', planned), 'plan');
});

test('PLAN gates on approval: an approval routes to BUILD, edits keep re-planning', () => {
  assert.equal(preRoute(sess({ phase: 'plan' }), 'approve — build it').phase, 'build');
  assert.equal(preRoute(sess({ phase: 'plan' }), 'actually add a search box first').phase, 'plan');
});

test('BUILD advances to FEEDBACK once something is committed', () => {
  const committed = extractSignals({
    plan: '',
    steps: [{ tool: 'create_software', args: {}, result: '{"id":"app_ab12cd3","slug":"x"}', isError: false }],
    finalText: 'created',
    iterations: 1,
    toolCallingSupported: true,
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.appId, 'app_ab12cd3');
  assert.equal(postRoute('build', committed), 'feedback');

  // Nothing committed → stay in build.
  const none = extractSignals({ plan: '', steps: [], finalText: 'thinking', iterations: 0, toolCallingSupported: true });
  assert.equal(postRoute('build', none), 'build');
});

test('FEEDBACK loops until "ship it" — the tester→builder loop the old walk could not do', () => {
  // A plain feedback message keeps iterating (builder diff-commits again).
  assert.equal(preRoute(sess({ phase: 'feedback', appId: 'app_x' }), 'rename the heading').phase, 'feedback');
  assert.equal(preRoute(sess({ phase: 'feedback', appId: 'app_x' }), 'rename the heading').role, 'builder');
  // "ship it" routes to the deploy phase (request_deploy → Builder review card).
  assert.equal(preRoute(sess({ phase: 'feedback', appId: 'app_x' }), 'looks good, ship it').phase, 'deploy');
});

test('DEPLOY finishes at done; each phase maps to exactly one role-agent', () => {
  assert.equal(postRoute('deploy', extractSignals({ plan: '', steps: [], finalText: 'card rev_1', iterations: 1, toolCallingSupported: true })), 'done');
  assert.deepEqual(Object.keys(ROLE_BY_PHASE).sort(), ['build', 'deploy', 'done', 'feedback', 'intake', 'plan']);
  assert.equal(ROLE_BY_PHASE.deploy, 'deployer');
});

test('intent detectors are phase-scoped', () => {
  assert.ok(isApproval('LGTM, go ahead'));
  assert.ok(!isApproval('can you change the colour'));
  assert.ok(isShip('ready to deploy'));
  assert.ok(!isShip('add another column'));
});

test('control tags are stripped from the user-facing reply', () => {
  assert.equal(stripControlTags('Here is the plan.\n[[PLAN_READY]]'), 'Here is the plan.');
  assert.equal(stripControlTags('1. Who? 2. What? [[QUESTIONS]]'), '1. Who? 2. What?');
});

// ----------------------------------------------------- Session persistence -----

test('session state persists across a fresh getSession (globalThis pin, survives a "restart")', () => {
  const key = 'user:persist-test';
  resetSession(key);
  assert.equal(getSession(key).phase, 'intake'); // default for a new session
  saveSession(key, sess({ phase: 'feedback', appId: 'app_persist', planApproved: true }));
  // A fresh call (simulating a new request / pod) still sees the persisted phase.
  const reloaded = getSession(key);
  assert.equal(reloaded.phase, 'feedback');
  assert.equal(reloaded.appId, 'app_persist');
  assert.equal(reloaded.planApproved, true);
  resetSession(key);
  assert.equal(getSession(key).phase, 'intake');
});

// ----------------------------------------------- Honest, typed error surfacing -

test('a weekly-budget 429 surfaces as a DISTINCT typed error — not "offline"', () => {
  const budget = classifyTeamError(new Error('LiteLLM 429: {"error":"weekly budget exceeded for team"}'));
  assert.equal(budget.kind, 'budget');
  assert.match(budget.message, /budget/i);
  assert.notEqual(budget.kind, 'offline');

  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.equal(classifyTeamError(abort).kind, 'timeout');

  const model = classifyTeamError(new Error('LiteLLM 500: upstream model error'));
  assert.equal(model.kind, 'model');

  const offline = classifyTeamError(new Error('fetch failed: ECONNREFUSED'));
  assert.equal(offline.kind, 'offline');
});

// -------------------------------------------- Integration: one agent per turn --

/** A scripted LLM: PLAN calls (no tools) return a plan; ACT calls return the script per model. */
function scriptLlm(actByModel: Record<string, LlmCompletion>): LlmCall {
  return async (req) => {
    if (!req.tools) return { content: 'plan: do the thing', toolCalls: [] };
    return actByModel[req.model] ?? { content: `done (${req.model})`, toolCalls: [] };
  };
}

function deps(over: Partial<AgenticGraphDeps> = {}): AgenticGraphDeps {
  return {
    llm: scriptLlm({}),
    toolSpecsFor: () => [],
    callTool: async () => ({ text: 'ok', isError: false }),
    preamble: 'OS RULES + build spec',
    reasoningModel: 'sovereign-reasoning',
    execModel: 'sovereign-default',
    maxIterations: 2,
    ...over,
  };
}

test('INTAKE turn: the planner asks questions and creates NO app (no build tool executed)', async () => {
  const executed: string[] = [];
  const run = await runNode(IR, 'planner', [{ role: 'user', content: 'build something' }], deps({
    llm: scriptLlm({ 'sovereign-reasoning': { content: '1. Who uses it? 2. What fields? [[QUESTIONS]]', toolCalls: [] } }),
    callTool: async (name) => {
      executed.push(name);
      return { text: 'ok', isError: false };
    },
  }), { extraGuidance: 'PHASE: INTAKE. Ask only what is missing.' });

  const signals = extractSignals(run.result);
  assert.equal(signals.planReady, false);
  assert.equal(postRoute('intake', signals), 'intake');
  assert.ok(!executed.includes('create_software'), 'no app is created during intake');
  assert.equal(executed.length, 0, 'the planner runs no tools when only asking questions');
});

test('BUILD turn: the builder commits, we capture the appId, and advance to FEEDBACK', async () => {
  const executed: string[] = [];
  const createSpec: ToolSpec = {
    name: 'create_software',
    description: 'Create a governed app.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  };
  const run = await runNode(IR, 'builder', [{ role: 'user', content: 'approve — build it' }], deps({
    llm: scriptLlm({
      'sovereign-default': { content: '', toolCalls: [{ id: 'c1', name: 'create_software', args: { name: 'Renewals' } }] },
    }),
    toolSpecsFor: (n) => (n.id === 'builder' ? [createSpec] : []),
    callTool: async (name) => {
      executed.push(name);
      return { text: '{"id":"app_zz99","slug":"renewals"}', isError: false };
    },
  }), { extraGuidance: 'PHASE: BUILD.' });

  const signals = extractSignals(run.result);
  assert.ok(executed.includes('create_software'), 'the builder actually creates the app');
  assert.equal(signals.committed, true);
  assert.equal(signals.appId, 'app_zz99');
  assert.equal(postRoute('build', signals), 'feedback');
});

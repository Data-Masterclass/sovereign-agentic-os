/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentic,
  parseReactAction,
  toOpenAiTools,
  ToolCallingUnsupportedError,
  type LlmCall,
  type ToolSpec,
} from './agentic.ts';

const TOOLS: ToolSpec[] = [
  {
    name: 'commit',
    description: 'Commit files to the app.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
  },
  {
    name: 'request_deploy',
    description: 'Open the Builder review gate.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
  },
];

/** A scripted LLM: returns queued completions in order; records the calls it saw. */
function scriptLlm(script: Array<{ content: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] }>) {
  const calls: { model: string; hadTools: boolean; messages: number }[] = [];
  let i = 0;
  const llm: LlmCall = async (req) => {
    calls.push({ model: req.model, hadTools: !!req.tools, messages: req.messages.length });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return { content: step.content, toolCalls: step.toolCalls ?? [] };
  };
  return { llm, calls };
}

test('toOpenAiTools wraps each ToolSpec into an OpenAI function tool', () => {
  const wire = toOpenAiTools(TOOLS);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].type, 'function');
  assert.equal(wire[0].function.name, 'commit');
  assert.deepEqual(wire[0].function.parameters, TOOLS[0].inputSchema);
});

test('parseReactAction reads a fenced JSON action, a bare action, and a final', () => {
  assert.deepEqual(parseReactAction('```json\n{"tool":"commit","args":{"appId":"a1"}}\n```'), {
    tool: 'commit',
    args: { appId: 'a1' },
  });
  assert.deepEqual(parseReactAction('sure: {"tool":"request_deploy","args":{"appId":"a1"}}'), {
    tool: 'request_deploy',
    args: { appId: 'a1' },
  });
  assert.equal(parseReactAction('All done — the preview is live.'), null);
  assert.equal(parseReactAction('{"final":"done"}'), null);
});

test('the loop PLANS with the reasoning model then ACTS with the exec model', async () => {
  const { llm, calls } = scriptLlm([
    { content: '1. Generate files\n2. commit\n3. deploy' }, // plan (no tools)
    { content: 'All committed and deploy requested.' }, // act: final immediately
  ]);
  const executed: string[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'build a todo app' }],
    tools: TOOLS,
    callTool: async (name) => {
      executed.push(name);
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'reason-x',
    actModel: 'exec-y',
  });
  assert.match(res.plan, /Generate files/);
  assert.equal(calls[0].model, 'reason-x');
  assert.equal(calls[0].hadTools, false); // planning never passes tools
  assert.equal(calls[1].model, 'exec-y');
  assert.equal(calls[1].hadTools, true); // native tool-calling passes tools
  assert.equal(res.finalText, 'All committed and deploy requested.');
  assert.equal(res.steps.length, 0);
  assert.equal(executed.length, 0);
});

test('native tool-calls are executed through the governed callTool and fed back', async () => {
  const { llm } = scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: 'commit', args: { appId: 'a1' } }] },
    { content: '', toolCalls: [{ id: 'c2', name: 'request_deploy', args: { appId: 'a1' } }] },
    { content: 'Done: committed then opened the deploy review gate.' },
  ]);
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'ship it' }],
    tools: TOOLS,
    callTool: async (name, args) => {
      executed.push({ name, args });
      return { text: `${name} ok`, isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.deepEqual(executed.map((e) => e.name), ['commit', 'request_deploy']);
  assert.deepEqual(executed[0].args, { appId: 'a1' });
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].tool, 'request_deploy');
  assert.equal(res.finalText, 'Done: committed then opened the deploy review gate.');
  assert.equal(res.toolCallingSupported, true);
});

test('the iteration cap holds — the loop stops after maxIterations tool rounds', async () => {
  // The model never emits a final; it always asks for another tool call. Each call
  // is DISTINCT (varying args) so the dedup guard doesn't trip — this exercises the
  // pure iteration cap, not the repeated-call break.
  let n = 0;
  const llm: LlmCall = async () => ({
    content: '',
    toolCalls: [{ id: `x${n}`, name: 'commit', args: { appId: `a${n++}` } }],
  });
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'loop forever' }],
    tools: TOOLS,
    callTool: async () => {
      executed += 1;
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 3,
  });
  assert.equal(res.iterations, 3);
  assert.equal(executed, 3);
  assert.match(res.finalText, /step limit|cap/i);
});

test('a cap-hit run still emits a BEST final synthesis (not just the bare cap notice)', async () => {
  // The model keeps calling tools until the cap; the FINAL no-tools synthesis call
  // (tools param absent) returns a real answer. We assert the node returns that
  // answer WITH a soft cap note appended — never a bare stub.
  let n = 0;
  const llm: LlmCall = async (req) => {
    if (!req.tools) {
      // Two no-tools calls happen: the PLAN (first) and the cap-hit synthesis (last).
      // Distinguish by whether the transcript already contains tool observations.
      const midRun = req.messages.some((m) => m.role === 'tool' || (m.role === 'user' && m.content.startsWith('You have reached')));
      return { content: midRun ? 'Best-effort conclusion from the data gathered.' : 'plan', toolCalls: [] };
    }
    // DISTINCT args per turn so the iteration cap (not the dedup guard) is what stops us.
    return { content: '', toolCalls: [{ id: `x${n}`, name: 'commit', args: { appId: `a${n++}` } }] };
  };
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'analyze everything' }],
    tools: TOOLS,
    callTool: async () => { executed += 1; return { text: 'ok', isError: false }; },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 2,
  });
  assert.equal(res.iterations, 2, 'the cap held');
  assert.equal(executed, 2, 'the synthesis call ran no further tools');
  assert.match(res.finalText, /Best-effort conclusion/, 'the node returns a real synthesized answer');
  assert.match(res.finalText, /tool-step budget/i, 'a soft cap note is appended');
  assert.doesNotMatch(res.finalText, /^Reached the tool step limit/, 'not the bare cap stub');
});

test('an EXACT repeated (tool,args) call executes the tool ONCE; repeats get a short synthetic note', async () => {
  // The model requests the SAME query_data call 3x, then finalizes. The governed
  // executor must run only ONCE; the 2 repeats are answered with a short dedup note
  // that never re-appends the (big) result — keeping context bounded.
  const BIG = 'ROW,'.repeat(5_000); // a large result the loop must NOT re-append
  const query: ToolSpec = {
    name: 'query_data',
    description: 'Run SQL.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
  };
  const dupCall = { id: 'q', name: 'query_data', args: { sql: 'select 1' } };
  const { llm } = scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [dupCall] },
    { content: '', toolCalls: [dupCall] }, // exact repeat
    { content: '', toolCalls: [dupCall] }, // exact repeat again
    { content: 'The trend is up.' },
  ]);
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'compute the trend' }],
    tools: [query],
    callTool: async () => { executed += 1; return { text: BIG, isError: false }; },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 8,
  });
  assert.equal(executed, 1, 'the underlying tool ran exactly once despite 3 identical requests');
  assert.equal(res.steps.length, 3, 'all three requests are recorded (drill-down still shows the repeats)');
  assert.equal(res.steps[0].result, BIG, 'the first step carries the real result');
  assert.ok(res.steps[1].result.length < 400, 'the deduped repeat is a SHORT note, not the full payload');
  assert.equal(res.steps[1].isError, false, 'a deduped repeat is recorded as a non-error step');
  assert.match(res.steps[1].result, /already ran this exact call/i);
  // Context stays bounded: only ONE copy of the big payload is ever in the transcript.
  assert.match(res.finalText, /The trend is up/);
});

test('a node stuck re-firing the identical call breaks to a final synthesis and hands off', async () => {
  // The model ALWAYS requests the same call and never finalizes on its own. The
  // repeat budget must trip, stopping the loop and forcing a real final answer.
  const dupCall = { id: 'q', name: 'query_data', args: { sql: 'select 1' } };
  const query: ToolSpec = {
    name: 'query_data',
    description: 'Run SQL.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
  };
  const llm: LlmCall = async (req) => {
    // The forced final-synthesis call passes NO tools and asks for the final answer.
    if (!req.tools) {
      const midRun = req.messages.some((m) => m.role === 'tool' || (m.role === 'user' && m.content.startsWith('You have reached')));
      return { content: midRun ? 'Best-effort trend from the rows I already have.' : 'plan', toolCalls: [] };
    }
    return { content: 'I have the data, now I compute manually…', toolCalls: [dupCall] };
  };
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'compute the trend' }],
    tools: [query],
    callTool: async () => { executed += 1; return { text: 'rows', isError: false }; },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 20, // high, so the REPEAT budget (not the iteration cap) is what stops us
  });
  assert.equal(executed, 1, 'the tool ran once; every later identical request was deduped');
  assert.ok(res.iterations < 20, 'the run stopped well before the iteration cap');
  assert.match(res.finalText, /Best-effort trend/, 'the node emits a real synthesized answer and hands off');
  assert.match(res.finalText, /tool-step budget/i, 'a soft cap note is appended');
});

test('a node whose SAME tool ERRORS N times in a row (varied args) breaks to a final synthesis', async () => {
  // The model keeps calling query_data with a DIFFERENT sql each turn (so exact-dedup
  // never trips), and every call errors. The consecutive-error breaker must stop the
  // loop after 4 errors and force a real final answer (the mislabeled-loop fix).
  const query: ToolSpec = {
    name: 'query_data',
    description: 'Run SQL.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
  };
  let n = 0;
  const llm: LlmCall = async (req) => {
    if (!req.tools) {
      const midRun = req.messages.some((m) => m.role === 'user' && m.content.startsWith('You have reached'));
      return { content: midRun ? 'Best-effort answer from what I gathered.' : 'plan', toolCalls: [] };
    }
    n += 1;
    // A fresh, DISTINCT sql each turn → the exact-dedup guard cannot fire.
    return { content: '', toolCalls: [{ id: `q${n}`, name: 'query_data', args: { sql: `select ${n}` } }] };
  };
  let executed = 0;
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'compute the trend' }],
    tools: [query],
    // Every call errors (a Trino syntax error, not a policy denial).
    callTool: async () => { executed += 1; return { text: 'TrinoUserError SYNTAX_ERROR', isError: true }; },
    llm,
    planModel: 'r',
    actModel: 'e',
    maxIterations: 20, // high, so the ERROR-streak breaker (not the iteration cap) stops us
  });
  assert.equal(executed, 4, 'the tool ran exactly 4 times before the consecutive-error break');
  assert.ok(res.iterations < 20, 'the run stopped well before the iteration cap');
  const errorSteps = res.steps.filter((s) => s.isError);
  assert.equal(errorSteps.length, 4, 'all four errored steps are recorded');
  // The 4th errored step carries the firm stop note as its fed-back result is injected;
  // the run still produces a real final answer and hands off.
  assert.match(res.finalText, /Best-effort answer/, 'the node emits a real synthesized answer and hands off');
});

test('falls back to the ReAct JSON protocol when the model rejects the tools param', async () => {
  // Native attempt throws ToolCallingUnsupportedError once; then the model drives
  // via JSON actions in plain text (no tools param passed after the fallback).
  let planned = false;
  const seenTools: boolean[] = [];
  const llm: LlmCall = async (req) => {
    if (!planned && !req.tools) {
      planned = true;
      return { content: 'plan', toolCalls: [] }; // the PLAN call
    }
    seenTools.push(!!req.tools);
    if (req.tools) throw new ToolCallingUnsupportedError('model has no function-calling');
    // ReAct mode: first drive a tool, then finish (an Observation turn is a
    // user message that STARTS with "Observation:", distinct from the protocol
    // instructions in the system prompt that merely mention the word).
    if (!req.messages.some((m) => m.role === 'user' && m.content.startsWith('Observation:'))) {
      return { content: '```json\n{"tool":"commit","args":{"appId":"a1"}}\n```', toolCalls: [] };
    }
    return { content: 'All set via ReAct.', toolCalls: [] };
  };
  const executed: string[] = [];
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'build' }],
    tools: TOOLS,
    callTool: async (name) => {
      executed.push(name);
      return { text: 'ok', isError: false };
    },
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.equal(res.toolCallingSupported, false);
  assert.deepEqual(executed, ['commit']);
  assert.equal(res.finalText, 'All set via ReAct.');
});

test('the ACT system prompt carries the discover-then-query directive when a data tool is present', async () => {
  // Capture the system message the ACT call sees. With query_data available the
  // prompt must tell the model to list_datasets→get_dataset for the EXACT FQN and
  // never guess a schema/table (#97).
  const actSystems: string[] = [];
  const llm: LlmCall = async (req) => {
    if (req.tools) actSystems.push(req.messages.find((m) => m.role === 'system')?.content ?? '');
    return { content: req.tools ? 'done' : 'plan', toolCalls: [] };
  };
  const dataTools: ToolSpec[] = [
    { name: 'query_data', description: 'Run a SQL query.', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_datasets', description: 'List datasets.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_dataset', description: 'Get a dataset.', inputSchema: { type: 'object', properties: {} } },
  ];
  await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'how many rows?' }],
    tools: dataTools,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  const prompt = actSystems[0] ?? '';
  assert.match(prompt, /DISCOVER BEFORE YOU ACT/);
  assert.match(prompt, /list_datasets/);
  assert.match(prompt, /get_dataset/);
  assert.match(prompt, /iceberg\.<schema>\.<table>/);
  assert.match(prompt, /never guess/i);
});

test('the ACT prompt overrides a STALE personal_<uid> FQN toward the promoted domain gold', async () => {
  // Cowork #0.1.70: agents kept querying a remembered `personal_aborek.*` (or a
  // hallucinated table) after a dataset was promoted to a DOMAIN gold asset. The
  // runtime never injects an FQN itself — but a stale one baked into the role prompt
  // (AGENT.md) would mislead. The DATA directive must tell the model to treat any such
  // name as a hint, re-resolve via get_dataset/profile_dataset, and query the domain
  // gold path (iceberg.<domain>.gold_<slug>), NEVER the owner's personal_<uid> lane.
  const actSystems: string[] = [];
  const llm: LlmCall = async (req) => {
    if (req.tools) actSystems.push(req.messages.find((m) => m.role === 'system')?.content ?? '');
    return { content: req.tools ? 'done' : 'plan', toolCalls: [] };
  };
  const dataTools: ToolSpec[] = [
    { name: 'query_data', description: 'Run a SQL query.', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_datasets', description: 'List datasets.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_dataset', description: 'Get a dataset.', inputSchema: { type: 'object', properties: {} } },
    { name: 'profile_dataset', description: 'Profile a dataset.', inputSchema: { type: 'object', properties: {} } },
  ];
  await runAgentic({
    // A role prompt carrying the exact stale FQN from the live incident.
    system: 'Query iceberg.personal_aborek.gold_campaign_data for the totals.',
    userMessages: [{ role: 'user', content: 'how many rows?' }],
    tools: dataTools,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  const prompt = actSystems[0] ?? '';
  // The directive names the CORRECT promoted target shape and warns off the stale lane.
  assert.match(prompt, /iceberg\.<domain>\.gold_<slug>/);
  assert.match(prompt, /STALE/);
  assert.match(prompt, /personal_<uid>/);
  assert.match(prompt, /re-resolve/i);
});

test('the discovery directive is omitted when no data/knowledge/files tool is present', async () => {
  // A software-only agent (commit/request_deploy) gets no data directive clutter.
  const actSystems: string[] = [];
  const llm: LlmCall = async (req) => {
    if (req.tools) actSystems.push(req.messages.find((m) => m.role === 'system')?.content ?? '');
    return { content: req.tools ? 'done' : 'plan', toolCalls: [] };
  };
  await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'ship' }],
    tools: TOOLS,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.doesNotMatch(actSystems[0] ?? '', /DISCOVER BEFORE YOU ACT/);
});

test('displayed text is guarded — leaked <think> reasoning is stripped', async () => {
  const { llm } = scriptLlm([
    { content: '<think>secret plan</think>1. do it' },
    { content: '<think>reason</think>Final answer.' },
  ]);
  const res = await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'x' }],
    tools: TOOLS,
    callTool: async () => ({ text: 'ok', isError: false }),
    llm,
    planModel: 'r',
    actModel: 'e',
  });
  assert.equal(res.plan.includes('secret plan'), false);
  assert.equal(res.finalText, 'Final answer.');
});

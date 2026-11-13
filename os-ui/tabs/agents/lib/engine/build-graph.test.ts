/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    buildGraph behaviour tests — channels, node-level tool gate, supervisor decisions,
 *             guards, budget, ReAct fallback, compile errors, live events
 * USER STORY: As the engine-rebuild engineer I want the checklist items A7, A9, A10, A11 and the
 *             A0 findings (node narrowing, guard routing) pinned by tests that need no model, no
 *             network and no server-only module.
 * ARCHITECTURE:
 *   - Pure: a local scripted `LlmCall`, a spy tool executor, hand-written system.yaml strings,
 *     `runGraphEngine` with a private MemorySaver. The real grant gates are exercised by
 *     `parity.test.ts`; here the deps are minimal so each assertion isolates ONE engine rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { ToolCallingUnsupportedError, type LlmCall, type LlmRequest, type ToolSpec } from '@core/runtime/agentic';
import {
  buildGraph,
  channelDefault,
  channelTypeOf,
  GraphCompileError,
  parseStateWrite,
  SET_STATE_TOOL_NAME,
  type GraphDeps,
  type SettableChannel,
} from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { runGraphEngine, type EngineRunInput } from '@tabs/agents/lib/engine/run';

const TASK = 'Do the task.';
const SPECS: Record<string, ToolSpec> = {
  search_knowledge: { name: 'search_knowledge', description: 'search', inputSchema: { type: 'object', properties: {} } },
  query_data: { name: 'query_data', description: 'query', inputSchema: { type: 'object', properties: {} } },
};

const ROLE = /--- YOUR ROLE IN THE TEAM: (\S+) ---/;
function nodeOf(req: LlmRequest): string {
  for (const m of req.messages) if (m.role === 'system') { const h = ROLE.exec(m.content); if (h) return h[1]; }
  return '?';
}

type ScriptOpts = {
  /** Which tool a node's first ACT calls (default: its first advertised tool). */
  callTool?: (node: string, advertised: string[]) => string | null;
  /** Supervisor decisions per supervisor, in order (default: members in declared order, then END). */
  route?: Record<string, string[]>;
  /** Throw ToolCallingUnsupportedError on the first ACT that carries tools (A11). */
  rejectNativeTools?: boolean;
  /** Reply to ACT in ReAct JSON (used after `rejectNativeTools`). */
  reactReply?: boolean;
};

function script(opts: ScriptOpts = {}): LlmCall {
  const acts = new Map<string, number>();
  const routed = new Map<string, number>();
  let rejected = false;
  return async (req) => {
    const node = nodeOf(req);
    if (!req.tools) {
      // PLAN, a ReAct ACT (no tools param), or a cap synthesis.
      if (acts.has(node) && opts.reactReply) {
        const n = (acts.get(node) ?? 0) + 1;
        acts.set(node, n);
        return { content: n === 1 ? `{"tool":"search_knowledge","args":{"q":"react:${node}"}}` : `FINAL(${node}) via react`, toolCalls: [] };
      }
      if (!acts.has(node)) acts.set(node, 0);
      return { content: `plan(${node})`, toolCalls: [] };
    }
    if (req.tools.length === 1 && req.tools[0].function.name === 'route') {
      const props = req.tools[0].function.parameters.properties as Record<string, { enum?: string[] }>;
      const members = (props.next?.enum ?? []).filter((m) => m !== 'END');
      const order = opts.route?.[node] ?? [...members, 'END'];
      const n = routed.get(node) ?? 0;
      routed.set(node, n + 1);
      return { content: '', toolCalls: [{ id: `r-${node}-${n}`, name: 'route', args: { next: order[n] ?? 'END', brief: order[n] === 'END' ? 'supervisor summary' : '' } }] };
    }
    if (opts.rejectNativeTools && !rejected) { rejected = true; throw new ToolCallingUnsupportedError(); }
    const n = (acts.get(node) ?? 0) + 1;
    acts.set(node, n);
    const advertised = req.tools.map((t) => t.function.name);
    const tool = opts.callTool ? opts.callTool(node, advertised) : advertised[0] ?? null;
    if (n === 1 && tool) return { content: '', toolCalls: [{ id: `c-${node}-1`, name: tool, args: { q: node } }] };
    return { content: `FINAL(${node})`, toolCalls: [] };
  };
}

function depsFor(sysYaml: string, llm: LlmCall, extra: Partial<GraphDeps> = {}) {
  const sys = parseSystem(sysYaml);
  const ir = compile(sys);
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const deps: Omit<GraphDeps, 'checkpointer'> = {
    llm,
    toolSpecsFor: (node) => node.tools.map((t) => SPECS[t]).filter(Boolean),
    callTool: async (tool, args) => { calls.push({ tool, args }); return { text: JSON.stringify({ ran: tool }), isError: false }; },
    preamble: 'RULES',
    reasoningModel: 'reasoning',
    execModel: 'fast',
    maxIterations: 4,
    ...extra,
  };
  return { sys, ir, deps, calls };
}

async function run(sysYaml: string, llm: LlmCall, extra: Partial<GraphDeps> = {}, input: Partial<EngineRunInput> = {}) {
  const { ir, deps, calls } = depsFor(sysYaml, llm, extra);
  const result = await runGraphEngine({ ir, deps, messages: [{ role: 'user', content: TASK }], runId: `t-${Math.random()}`, checkpointer: memoryCheckpointer(), ...input });
  return { result, calls };
}

const TWO_AGENTS = `version: '1'
system: { name: two, domain: sales, visibility: Personal }
entrypoint: a
state:
  channels:
    messages: add_messages
    notes: add_messages
    flag: last_value
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, query_data], connections: [] }
agents:
  - { id: a, role: first, agent_md: '# a', memory_md: '# Memory', tools: [search_knowledge] }
  - { id: b, role: second, agent_md: '# b', memory_md: '# Memory', tools: [query_data] }
edges:
  - { from: a, to: b, type: handoff }
`;

const SUPERVISED = `version: '1'
system: { name: sup, domain: sales, visibility: Personal }
entrypoint: lead
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, query_data], connections: [] }
agents:
  - { id: lead, role: lead, agent_md: '# lead', memory_md: '# Memory', tools: [], members: [researcher, analyst] }
  - { id: researcher, role: r, agent_md: '# r', memory_md: '# Memory', tools: [search_knowledge] }
  - { id: analyst, role: a, agent_md: '# a', memory_md: '# Memory', tools: [query_data] }
edges:
  - { from: lead, to: researcher, type: supervise }
  - { from: lead, to: analyst, type: supervise }
`;

function guarded(when: string): string {
  return `version: '1'
system: { name: g, domain: sales, visibility: Personal }
entrypoint: a
state:
  channels:
    messages: add_messages
    findings_ready: last_value
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: a, role: first, agent_md: '# a', memory_md: '# Memory', tools: [search_knowledge] }
  - { id: b, role: second, agent_md: '# b', memory_md: '# Memory', tools: [search_knowledge] }
edges:
  - { from: a, to: b, type: handoff, when: ${JSON.stringify(when)} }
`;
}

test('A9: declared channels exist in graph state with the declared reducer (add_messages appends, last_value overwrites)', async () => {
  const { ir, deps } = depsFor(TWO_AGENTS, script());
  const cp = memoryCheckpointer();
  const { graph, names } = buildGraph(ir, { ...deps, checkpointer: cp.saver });
  const cfg = { configurable: { thread_id: 'channels' } };
  await graph.updateState(cfg, { notes: ['n1'], flag: 'first' }, names('a').route);
  await graph.updateState(cfg, { notes: 'n2', flag: 'second' }, names('a').route);
  const snap = await graph.getState(cfg);
  const values = snap.values as unknown as Record<string, unknown>;
  assert.deepEqual(values.notes, ['n1', 'n2'], 'add_messages appends');
  assert.equal(values.flag, 'second', 'last_value overwrites');
  assert.deepEqual(values.messages, [], 'messages is the shared append channel');
});

test('A1 unconditional handoff: a → b, two visits, b speaks last, every superstep checkpointed under thread id = run id', async () => {
  const cp = memoryCheckpointer();
  const { result, calls } = await run(TWO_AGENTS, script(), {}, { runId: 'run-two', checkpointer: cp });
  assert.deepEqual(result.path, ['a', 'b']);
  assert.deepEqual(calls.map((c) => c.tool), ['search_knowledge', 'query_data']);
  assert.equal(result.finalText, 'FINAL(b)');
  assert.equal(result.reachedEnd, true);
  assert.equal(result.checkpointer, 'memory');
  assert.equal(result.runId, 'run-two');
  const { ir, deps } = depsFor(TWO_AGENTS, script());
  const { graph } = buildGraph(ir, { ...deps, checkpointer: cp.saver });
  let checkpoints = 0;
  for await (const _ of graph.getStateHistory({ configurable: { thread_id: 'run-two' } })) checkpoints += 1;
  assert.ok(checkpoints >= 8, `expected a checkpoint per superstep (plan/act/tools/act/route × 2), got ${checkpoints}`);
});

test('A0 finding 1: tools_<id> executes ONLY the tools the node is advertised — an un-advertised call never reaches the executor', async () => {
  const { result, calls } = await run(TWO_AGENTS, script({ callTool: (node) => (node === 'a' ? 'query_data' : 'query_data') }));
  // Agent a is advertised search_knowledge only; the model asked for query_data anyway.
  assert.deepEqual(calls.map((c) => c.tool), ['query_data'], 'only agent b (advertised query_data) reached the executor');
  const a = result.runs.find((r) => r.node === 'a')!;
  assert.equal(a.status, 'denied', 'a structural grant block is a policy denial');
  assert.equal(a.result.steps[0].tool, 'query_data');
  assert.match(a.result.steps[0].result, /"code":"not_found"/);
  assert.match(a.result.steps[0].result, /agent 'a'/);
});

test('A7: the supervisor DECIDES — a scripted supervisor choosing analyst first visits analyst first, and its END brief is the final text', async () => {
  const { result, calls } = await run(SUPERVISED, script({ route: { lead: ['analyst', 'researcher', 'END'] } }));
  assert.deepEqual(result.path, ['lead', 'analyst', 'researcher']);
  assert.deepEqual(calls.map((c) => c.tool), ['query_data', 'search_knowledge']);
  assert.deepEqual(result.routes.map((r) => r.next), ['analyst', 'researcher', 'END']);
  assert.equal(result.routes.every((r) => r.source === 'tool'), true);
  assert.equal(result.finalText, 'supervisor summary', 'the END brief is the team reply');
  assert.equal(result.reachedEnd, true);
});

test('A7: a supervisor naming a non-member ends the run honestly instead of routing blindly', async () => {
  const { result } = await run(SUPERVISED, script({ route: { lead: ['nobody'] } }));
  assert.deepEqual(result.path, ['lead']);
  assert.equal(result.routes[0].source, 'fallback');
  assert.match(result.finalText, /not one of its members/);
});

test('A8: a handoff whose guard is false does not visit its target; a literal true does; a channel nothing CAN set warns at compile', async () => {
  const falsy = await run(guarded('state.findings_ready'), script());
  assert.deepEqual(falsy.result.path, ['a'], 'findings_ready is declared but never set → b is not visited');
  assert.equal(falsy.result.reachedEnd, true);
  // The channel IS declared, so an agent could have set it: a false guard, not a broken one.
  assert.deepEqual(falsy.result.warnings, []);

  const truthy = await run(guarded('true'), script());
  assert.deepEqual(truthy.result.path, ['a', 'b']);
  assert.deepEqual(truthy.result.warnings, []);

  const bare = await run(guarded('plan_ready'), script());
  assert.deepEqual(bare.result.path, ['a']);
  assert.match(bare.result.warnings[0], /not declared in state.channels/);
  assert.match(bare.result.warnings[0], /no agent can set it/);
});

// --------------------------------------------- A8 / A5-review-H-2: writing a state channel --

/** The guarded two-agent shape with a TYPED channel `a` may set. */
function typedGuard(type: string, when = 'plan_ready'): string {
  return `version: '1'
system: { name: tg, domain: sales, visibility: Personal }
entrypoint: a
state:
  channels:
    messages: add_messages
    plan_ready: ${type}
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: a, role: first, agent_md: '# a', memory_md: '# Memory', tools: [search_knowledge] }
  - { id: b, role: second, agent_md: '# b', memory_md: '# Memory', tools: [search_knowledge] }
edges:
  - { from: a, to: b, type: handoff, when: ${JSON.stringify(when)} }
`;
}

/** A model that writes one channel from node `a`'s first turn, then answers. */
function writerScript(args: Record<string, unknown> | null): LlmCall {
  const acts = new Map<string, number>();
  return async (req) => {
    const node = nodeOf(req);
    if (!req.tools) return { content: `plan(${node})`, toolCalls: [] };
    const n = (acts.get(node) ?? 0) + 1;
    acts.set(node, n);
    if (n === 1 && node === 'a' && args) {
      return { content: '', toolCalls: [{ id: `s-${node}`, name: SET_STATE_TOOL_NAME, args }] };
    }
    return { content: `FINAL(${node})`, toolCalls: [] };
  };
}

test('H-2: the agent the guard follows is advertised `os_set_state`, and setting the channel ROUTES the guarded handoff', async () => {
  const offered = new Map<string, string[]>();
  const base = writerScript({ channel: 'plan_ready', value: true });
  const spy: LlmCall = async (req) => {
    if (req.tools) offered.set(nodeOf(req), req.tools.map((t) => t.function.name));
    return base(req);
  };
  const { result, calls } = await run(typedGuard('boolean'), spy);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.path, ['a', 'b'], 'the write made the guard true');
  assert.deepEqual(calls, [], 'the state write never reaches the GOVERNED executor');
  assert.ok(offered.get('a')?.includes(SET_STATE_TOOL_NAME), 'a carries the guard → a may set the channel');
  assert.ok(!offered.get('b')?.includes(SET_STATE_TOOL_NAME), 'b has no guard of its own → no setter');
  assert.ok(offered.get('a')?.includes('search_knowledge'), 'its governed grants are untouched');
});

test('H-2: the writer\'s system prompt names the channel it may set, generated from the declaration', async () => {
  const prompts: string[] = [];
  const base = writerScript(null);
  const spy: LlmCall = async (req) => {
    for (const m of req.messages) if (m.role === 'system' && nodeOf(req) === 'a') prompts.push(m.content);
    return base(req);
  };
  await run(typedGuard('boolean'), spy);
  const text = prompts.join('\n');
  assert.match(text, /--- STATE CHANNELS ---/);
  assert.match(text, /plan_ready \(boolean\): set it when control should pass to b/);
  assert.match(text, /os_set_state/);
});

test('H-2: the channel is closed to the DECLARATION — an undeclared name and a wrong type are typed tool errors, and neither routes', async () => {
  const undeclared = await run(typedGuard('boolean'), writerScript({ channel: 'nope', value: true }));
  assert.deepEqual(undeclared.result.path, ['a']);
  const mistyped = await run(typedGuard('boolean'), writerScript({ channel: 'plan_ready', value: { deep: 1 } }));
  assert.deepEqual(mistyped.result.path, ['a']);
  // The string forms a model emits for a boolean are accepted (and nothing else).
  const coerced = await run(typedGuard('boolean'), writerScript({ channel: 'plan_ready', value: 'true' }));
  assert.deepEqual(coerced.result.path, ['a', 'b']);
  // A number channel compared by value routes too (the `when` grammar's equality).
  const numeric = await run(typedGuard('number', 'plan_ready == "3"'), writerScript({ channel: 'plan_ready', value: 3 }));
  assert.deepEqual(numeric.result.path, ['a', 'b']);
});

test('H-2: `parseStateWrite` is the whole rule — it names what it refuses', () => {
  const allowed: SettableChannel[] = [['ready', 'boolean'], ['count', 'number'], ['note', 'string'], ['blob', 'json']];
  assert.deepEqual(parseStateWrite({ channel: 'ready', value: false }, allowed), { channel: 'ready', value: false });
  assert.deepEqual(parseStateWrite({ channel: 'count', value: '7' }, allowed), { channel: 'count', value: 7 });
  assert.deepEqual(parseStateWrite({ channel: 'blob', value: { a: 1 } }, allowed), { channel: 'blob', value: { a: 1 } });
  for (const [args, re] of [
    [{ value: true }, /needs a 'channel'/],
    [{ channel: 'other', value: true }, /not a declared state channel/],
    [{ channel: 'ready' }, /needs a 'value'/],
    [{ channel: 'ready', value: 3 }, /declared boolean/],
    [{ channel: 'count', value: 'many' }, /declared number/],
    [{ channel: 'note', value: 1 }, /declared string/],
  ] as const) {
    const out = parseStateWrite(args as Record<string, unknown>, allowed);
    assert.ok('error' in out, `${JSON.stringify(args)} must be refused`);
    assert.match(out.error, re);
  }
});

test('H-2: a guard over an `add_messages` channel still warns — the setter writes single values', async () => {
  const { result } = await run(typedGuard('add_messages'), writerScript(null));
  assert.deepEqual(result.path, ['a']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /add_messages reducer/);
});

test('H-2: a declared channel starts at its type\'s default', () => {
  assert.equal(channelDefault('boolean'), false);
  assert.equal(channelDefault('number'), 0);
  assert.equal(channelDefault('string'), '');
  assert.equal(channelDefault('json'), null);
  assert.equal(channelTypeOf('add_messages'), 'add_messages');
  assert.equal(channelTypeOf('boolean'), 'boolean');
  assert.equal(channelTypeOf('last_value'), 'json', 'a pre-types declaration stays an untyped json channel');
});

test('A10: the team step budget ends the run gracefully with what completed', async () => {
  const { result } = await run(TWO_AGENTS, script(), { maxRunSteps: 1 });
  assert.deepEqual(result.path, ['a'], 'a used the single step; b never started');
  assert.equal(result.reachedEnd, false);
  assert.equal(result.budget.exhausted, true);
  // a's per-visit cap was clamped to the 1 remaining step, so (as in the walker) its answer is the
  // no-tools cap synthesis + soft note; the run then appends the team budget note.
  assert.match(result.finalText, /synthesized after reaching the tool-step budget/);
  assert.match(result.finalText, /The team stopped at the run's tool-step budget/);
});

test('A10: recursionLimit derives from the step budget (four supersteps per step plus a head)', () => {
  const { ir, deps } = depsFor(TWO_AGENTS, script());
  const built = buildGraph(ir, { ...deps, maxRunSteps: 40 });
  assert.equal(built.stepBudget, 40);
  assert.equal(built.recursionLimit, 40 * 4 + 8);
});

test('A11: native tool-calling is the default; the ReAct text protocol is used only after the model rejects `tools`', async () => {
  const native = await run(guarded('false'), script());
  assert.equal(native.result.runs[0].result.toolCallingSupported, true);

  const react = await run(guarded('false'), script({ rejectNativeTools: true, reactReply: true }));
  assert.equal(react.result.runs[0].result.toolCallingSupported, false, 'the run records the fallback');
  assert.deepEqual(react.calls.map((c) => c.tool), ['search_knowledge'], 'the ReAct JSON action executed through the gate');
  assert.equal(react.result.finalText, 'FINAL(a) via react');
});

test('a node that throws is a failed visit; the run stops there with the failure visible', async () => {
  const boom: LlmCall = async (req) => { if (nodeOf(req) === 'b') throw new Error('gateway down'); return script()(req); };
  const { result } = await run(TWO_AGENTS, boom);
  assert.deepEqual(result.path, ['a', 'b']);
  assert.equal(result.runs[1].status, 'failed');
  assert.equal(result.runs[1].error, 'gateway down');
  assert.equal(result.reachedEnd, false);
  assert.match(result.finalText, /b failed: gateway down/);
});

test('disabled agents are pruned at build: a disabled member is never visited', async () => {
  const { result } = await run(SUPERVISED, script(), { disabled: ['researcher'] });
  assert.deepEqual(result.path, ['lead', 'analyst']);
});

test('compile errors: unmapped legacy tools, a disabled entrypoint, a malformed guard, a channel shadowing an engine key', () => {
  const { ir, deps } = depsFor(TWO_AGENTS, script());
  assert.throws(() => buildGraph(ir, { ...deps, unmappedTools: ['web_fetch'] }), (e: Error) => e instanceof GraphCompileError && /web_fetch/.test(e.message));
  assert.throws(() => buildGraph(ir, { ...deps, disabled: ['a'] }), (e: Error) => e instanceof GraphCompileError && /entrypoint 'a' is disabled/.test(e.message));
  const bad = depsFor(guarded('a &&'), script());
  assert.throws(() => buildGraph(bad.ir, bad.deps), (e: Error) => e instanceof GraphCompileError && /handoff a → b/.test(e.message));
  const shadow = depsFor(TWO_AGENTS.replace('flag: last_value', 'final: last_value'), script());
  assert.throws(() => buildGraph(shadow.ir, shadow.deps), (e: Error) => e instanceof GraphCompileError && /shadows an engine state key/.test(e.message));
});

test('live events arrive in order through the stream writer: node-started → tool-step → node-completed per agent', async () => {
  const seen: string[] = [];
  await run(TWO_AGENTS, script(), {}, {
    hooks: {
      onNodeStart: (ev) => seen.push(`start:${ev.node}:${ev.index}/${ev.total}`),
      onStep: (ev) => seen.push(`step:${ev.node}:${ev.step.tool}:${ev.index}`),
      onNodeComplete: (ev) => seen.push(`done:${ev.node}:${ev.status}`),
    },
  });
  assert.deepEqual(seen, [
    'start:a:1/2', 'step:a:search_knowledge:1', 'done:a:ok',
    'start:b:2/2', 'step:b:query_data:1', 'done:b:ok',
  ]);
});

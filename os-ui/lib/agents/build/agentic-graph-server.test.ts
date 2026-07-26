/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import type { LlmCall } from '@/lib/assistant/agentic';
import { parseSystem, serializeSystem, type System } from '../system-schema.ts';
import { SOFTWARE_TEAM_YAML } from '../software-team.ts';
import { isAgenticOsTeam, type OsToolDeps } from './os-tools.ts';
import { runOsTeam, osPreamble } from './agentic-graph-server.ts';
import { setModelPrices, _reset as resetModelPrices } from '@/lib/platform-admin/model-prices';

/**
 * T4 — the run graph is generalised to the whole OS toolset. These tests prove a
 * MIXED (data+knowledge) agentic-os team runs LIVE in-process as the ACTING USER
 * (governed dispatch threads `user:<id>`, never the service principal), that the
 * software team is a preserved subset, and that a hermes system stays on the
 * fallback path.
 */

const CREATOR: CurrentUser = { id: 'u1', name: 'Cara Creator', domains: ['sales'], role: 'creator' };

/** A single-agent system whose grants span TWO tabs (data + knowledge). */
function mixedYaml(): string {
  const sys: System = parseSystem({
    version: '1',
    system: { name: 'Insights', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'analyst',
    grants: { tools: ['query_data', 'search_knowledge'] },
    agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
  });
  return serializeSystem(sys);
}

/**
 * A fake LLM: the PLAN call (no tools) returns a plan; the FIRST ACT call (tools
 * present) emits a single `query_data` tool call; the next ACT call finishes. This
 * drives exactly one governed tool dispatch through the injected executor.
 */
function toolCallingLlm(toolName: string): LlmCall {
  let acts = 0;
  return async (req) => {
    if (!req.tools || req.tools.length === 0) return { content: 'plan: query the data', toolCalls: [] };
    acts += 1;
    if (acts === 1) return { content: '', toolCalls: [{ id: 'c1', name: toolName, args: { sql: 'select 1' } }] };
    return { content: 'done: analysed 1 row', toolCalls: [] };
  };
}

/** One recorded trace event (the run-summary trace the Monitoring tiles read). */
type TraceCall = Parameters<OsToolDeps['trace']>[0];

/** Spy deps: handleRpc records its (user, req, opts) and returns a real-shaped result. */
function spyDeps(): OsToolDeps & { calls: { handleRpc: { user: CurrentUser; name: string; toolNames: string[] }[]; trace: TraceCall[] } } {
  const calls = { handleRpc: [] as { user: CurrentUser; name: string; toolNames: string[] }[], trace: [] as TraceCall[] };
  const deps: OsToolDeps = {
    enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
    handleRpc: (async (user, req, opts) => {
      const name = (req.params as { name?: string })?.name ?? '';
      const toolNames = (opts?.tools ?? []).map((t: { name: string }) => t.name);
      calls.handleRpc.push({ user, name, toolNames });
      return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"rows":[{"n":1}]}' }] } };
    }) as OsToolDeps['handleRpc'],
    trace: (async (ev: TraceCall) => {
      calls.trace.push(ev);
      return {} as never;
    }) as OsToolDeps['trace'],
  };
  return Object.assign(deps, { calls });
}

// --- the mixed data+knowledge team runs live as the acting user --------------

test('runOsTeam: a MIXED data+knowledge team dispatches as the acting user (never a service principal)', async () => {
  const deps = spyDeps();
  const res = await runOsTeam({
    user: CREATOR,
    yaml: mixedYaml(),
    systemId: 'sys-mix',
    messages: [{ role: 'user', content: 'How many rows?' }],
    llm: toolCallingLlm('query_data'),
    toolDeps: deps,
    maxIterations: 3,
  });

  // Exactly one governed dispatch happened, through the injected handleRpc.
  assert.equal(deps.calls.handleRpc.length, 1, 'one governed tool dispatch');
  const call = deps.calls.handleRpc[0];
  // Identity: the dispatch ran as the ACTING USER object — user:u1, not os-sys-mix.
  assert.equal(call.user, CREATOR);
  assert.equal(call.user.id, 'u1');
  assert.equal(call.name, 'query_data');
  // Scope: handleRpc was scoped to the system's granted MCP tools (both tabs).
  assert.ok(call.toolNames.includes('query_data'));
  assert.ok(call.toolNames.includes('search_knowledge'));
  // The real (mocked-lib) tool result flowed back into the run trace + reply.
  const steps = res.runs.flatMap((r) => r.result.steps);
  const queryStep = steps.find((s) => s.tool === 'query_data');
  assert.ok(queryStep, 'the query_data step is recorded');
  assert.match(queryStep!.result, /"rows"/);
  assert.match(res.finalText, /analysed 1 row/);
});

// --- FIX 2 (observability): the run carries per-node status + finalText ----------

test('runOsTeam: each node run carries a derived STATUS and its finalText (the run-route response shape)', async () => {
  const deps = spyDeps();
  const res = await runOsTeam({
    user: CREATOR,
    yaml: mixedYaml(),
    systemId: 'sys-mix',
    messages: [{ role: 'user', content: 'How many rows?' }],
    llm: toolCallingLlm('query_data'),
    toolDeps: deps,
    maxIterations: 3,
  });

  // The route maps res.runs[] 1:1 into nodes[]: node + model + status + finalText +
  // steps. Prove every run object carries those fields the panel now renders.
  for (const r of res.runs) {
    assert.ok(typeof r.node === 'string' && r.node, 'node id present');
    assert.ok(['ok', 'failed', 'denied'].includes(r.status), 'a derived status is present');
    assert.ok(typeof r.result.finalText === 'string', 'the node finalText (its conclusion) is present');
  }
  // The single (successful) node analysed the rows → status ok, finalText carries it.
  const analyst = res.runs.find((r) => r.node === 'analyst');
  assert.ok(analyst, 'the analyst node ran');
  assert.equal(analyst!.status, 'ok', 'a node with no errored tool is ok');
  assert.match(analyst!.result.finalText, /analysed 1 row/, 'the node output is available per-node, not dropped');
});

// --- gate: os-team vs hermes fallback ----------------------------------------

test('isAgenticOsTeam gates the live path: mixed + software true, hermes false', () => {
  // The route runs runOsTeam iff this is true; otherwise it falls to runSystem.
  assert.equal(isAgenticOsTeam(parseSystem(mixedYaml())), true, 'mixed data+knowledge → live path');
  assert.equal(isAgenticOsTeam(parseSystem(SOFTWARE_TEAM_YAML)), true, 'software team is a preserved subset');

  const hermes = parseSystem({
    version: '1',
    system: { name: 'Legacy', domain: 'sales', visibility: 'Personal' },
    runtime: 'hermes',
    entrypoint: 'a',
    grants: { tools: ['query_data'] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  assert.equal(isAgenticOsTeam(hermes), false, 'hermes → runSystem fallback');
});

// --- preamble grounds in every granted tab -----------------------------------

test('osPreamble grounds a mixed team in the OS rules (tab-agnostic, no software-only leakage)', () => {
  const pre = osPreamble(parseSystem(mixedYaml()));
  assert.match(pre, /governed team inside the Sovereign Agentic OS/);
  assert.match(pre, /RUNNING USER/);
  // A data+knowledge team must NOT carry the software build-spec preamble.
  assert.doesNotMatch(pre, /BUILD SPEC \(canonical/);
});

// --- LIVE PROGRESS (0.1.81): runOsTeam forwards the streaming callbacks ----------

test('runOsTeam: forwards ordered node-started / tool-step / node-completed events (the stream source)', async () => {
  const deps = spyDeps();
  const events: { kind: string; node: string; extra?: unknown }[] = [];
  const res = await runOsTeam({
    user: CREATOR,
    yaml: mixedYaml(),
    systemId: 'sys-mix',
    messages: [{ role: 'user', content: 'How many rows?' }],
    llm: toolCallingLlm('query_data'),
    toolDeps: deps,
    maxIterations: 3,
    onNodeStart: (ev) => events.push({ kind: 'node-started', node: ev.node, extra: { index: ev.index, total: ev.total } }),
    onStep: (ev) => events.push({ kind: 'tool-step', node: ev.node, extra: { tool: ev.step.tool, isError: ev.step.isError } }),
    onNodeComplete: (ev) => events.push({ kind: 'node-completed', node: ev.node, extra: ev.status }),
  });

  // Terminal event is a node-completed, and the events reconstruct the run's node list.
  assert.equal(events[events.length - 1].kind, 'node-completed');
  const completed = events.filter((e) => e.kind === 'node-completed').map((e) => e.node);
  assert.deepEqual(completed, res.runs.map((r) => r.node), 'events rebuild the same per-node structure');

  // The single node's tool step streamed, bracketed by its start and complete.
  const iStart = events.findIndex((e) => e.kind === 'node-started');
  const iStep = events.findIndex((e) => e.kind === 'tool-step');
  const iDone = events.findIndex((e) => e.kind === 'node-completed');
  assert.ok(iStart < iStep && iStep < iDone, 'the tool-step is bracketed by node start/complete');
  assert.deepEqual(events[iStart].extra, { index: 1, total: res.runs.length });
});

// --- run-summary trace: Monitoring token/cost attribution -------------------------

/**
 * Like {@link toolCallingLlm}, but every completion REPORTS usage — plan 110, act1
 * 220, and the finishing act call reports none (a backend that omitted the block),
 * so the honest run total is 330 (missing usage counts 0, the rest still sum).
 */
function usageReportingLlm(toolName: string): LlmCall {
  let acts = 0;
  return async (req) => {
    if (!req.tools || req.tools.length === 0) {
      return { content: 'plan: query the data', toolCalls: [], usage: { input: 100, output: 10, total: 110 } };
    }
    acts += 1;
    if (acts === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'c1', name: toolName, args: { sql: 'select 1' } }],
        usage: { input: 200, output: 20, total: 220 },
      };
    }
    return { content: 'done: analysed 1 row', toolCalls: [] }; // no usage reported
  };
}

test('runOsTeam emits ONE run-summary trace with the summed token usage (Monitoring attribution)', async () => {
  const deps = spyDeps();
  const res = await runOsTeam({
    user: CREATOR,
    yaml: mixedYaml(),
    systemId: 'sys-mix',
    messages: [{ role: 'user', content: 'How many rows?' }],
    llm: usageReportingLlm('query_data'),
    toolDeps: deps,
    maxIterations: 3,
  });

  // Exactly ONE `:run` summary trace fired (no double-emit), mirroring runSystem's:
  // principal os-<id>:run (the telemetry batch only groups os- principals),
  // tool 'generate', decision allow, tokens = the run's summed reported usage.
  const runTraces = deps.calls.trace.filter((t) => t.principal === 'os-sys-mix:run');
  assert.equal(runTraces.length, 1, 'exactly one run-summary trace');
  const t = runTraces[0];
  assert.equal(t.tool, 'generate');
  assert.equal(t.decision, 'allow');
  assert.equal(t.tokens, 330, 'plan 110 + act 220; the usage-less final call adds 0');
  assert.deepEqual(t.input, { prompt: 'How many rows?' });
  assert.deepEqual(t.output, { path: res.path });
  // No price book in tests (env seed empty, store empty) → cost is undefined
  // ("—"), never a fabricated 0.
  assert.equal(t.costUsd, undefined);
});

test('runOsTeam prices the run from the ADMIN-SAVED price book (effectiveModelPrices, no env needed)', async () => {
  // Store a price for BOTH tier models this run calls (plan=sovereign-reasoning,
  // act=sovereign-default) in the durable store — no MODEL_PRICES_JSON env at all.
  resetModelPrices();
  setModelPrices({
    'sovereign-reasoning': { inputPerM: 1000, outputPerM: 2000 },
    'sovereign-default': { inputPerM: 1000, outputPerM: 2000 },
  }, 'admin');
  try {
    const deps = spyDeps();
    await runOsTeam({
      user: CREATOR,
      yaml: mixedYaml(),
      systemId: 'sys-priced',
      messages: [{ role: 'user', content: 'How many rows?' }],
      llm: usageReportingLlm('query_data'),
      toolDeps: deps,
      maxIterations: 3,
    });
    const t = deps.calls.trace.find((c) => c.principal === 'os-sys-priced:run');
    assert.ok(t, 'run-summary trace fired');
    // input 300 (100+200) at €1000/1M + output 30 (10+20) at €2000/1M = €0.36.
    assert.equal(t.costUsd, 0.36);
  } finally {
    resetModelPrices(); // later suites still see an honest unpriced ⇒ undefined
  }
});

test('runOsTeam run-summary trace carries tokens: undefined when NO call reported usage (never fabricated)', async () => {
  const deps = spyDeps();
  await runOsTeam({
    user: CREATOR,
    yaml: mixedYaml(),
    systemId: 'sys-mix',
    messages: [{ role: 'user', content: 'How many rows?' }],
    llm: toolCallingLlm('query_data'), // reports no usage at all
    toolDeps: deps,
    maxIterations: 3,
  });
  const runTraces = deps.calls.trace.filter((t) => t.principal === 'os-sys-mix:run');
  assert.equal(runTraces.length, 1, 'the summary trace still fires');
  assert.equal(runTraces[0].tokens, undefined, 'no reported usage → undefined, not 0');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { SOFTWARE_TEAM_YAML } from '@tabs/agents/lib/software-team';
import { unmappedGrantNames, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { runOsTeam, runPhaseTurn, osPreamble } from '@tabs/agents/lib/build/agentic-graph-server';
import { memoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import { phaseToolExecutor } from '@tabs/agents/lib/build/phase-tools';
import { resetSession, saveSession } from '@tabs/agents/lib/build/phase-router';
import { setModelPrices, _reset as resetModelPrices } from '@tabs/admin/lib/model-prices';

/**
 * T4 — the run graph is generalised to the whole OS toolset. These tests prove a
 * MIXED (data+knowledge) agentic-os team runs LIVE in-process as the ACTING USER
 * (governed dispatch threads `user:<id>`, never the service principal), that the
 * software team is a preserved subset, and that a grant with no governed tool behind it
 * is NAMED rather than silently routed somewhere else (A5 — there is nowhere else).
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
    runId: `run-test-0`,
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
    runId: `run-test-1`,
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

// --- A5: the pre-flight the run doors apply (there is no fallback path left) --

test('the run doors refuse ONLY a grant with no governed tool behind it, and name it', () => {
  assert.deepEqual(unmappedGrantNames(parseSystem(mixedYaml())), [], 'mixed data+knowledge runs');
  assert.deepEqual(unmappedGrantNames(parseSystem(SOFTWARE_TEAM_YAML)), [], 'software team is a preserved subset');

  // A system saved under the retired `hermes` runtime opens, normalises and runs.
  const legacy = parseSystem({
    version: '1',
    system: { name: 'Legacy', domain: 'sales', visibility: 'Personal' },
    runtime: 'hermes',
    entrypoint: 'a',
    grants: { tools: ['query_data'] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  assert.equal(legacy.runtime, 'langgraph', 'the retired engine name is normalised, not rejected');
  assert.deepEqual(unmappedGrantNames(legacy), []);

  const unmapped = parseSystem({
    version: '1',
    system: { name: 'Legacy grants', domain: 'sales', visibility: 'Personal' },
    entrypoint: 'a',
    grants: { tools: ['query_data', 'web_fetch'] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  assert.deepEqual(unmappedGrantNames(unmapped), ['web_fetch'], 'the door can name the offending grant');
});

// --- preamble grounds in every granted tab -----------------------------------

test('osPreamble grounds a mixed team in the OS rules (tab-agnostic, no software-only leakage)', () => {
  const pre = osPreamble(CREATOR, parseSystem(mixedYaml()));
  assert.match(pre, /governed team inside the Sovereign Agentic OS/);
  assert.match(pre, /RUNNING USER/);
  // A data+knowledge team must NOT carry the software build-spec preamble.
  assert.doesNotMatch(pre, /BUILD SPEC \(canonical/);
});

test('osPreamble advertises ONLY granted tools — no ungranted-tool leak from the tab catalog', () => {
  // A team granted only query_data (+ its read-only discovery companions) + search_knowledge.
  const pre = osPreamble(CREATOR, parseSystem(mixedYaml()));
  // The advertised, CALLABLE tools are the "- <name> — …" list entries in the brief.
  const advertised = new Set(
    pre.split('\n').map((l) => /^- (\w+) —/.exec(l)?.[1]).filter((n): n is string => !!n),
  );
  assert.ok(advertised.has('query_data'));
  assert.ok(advertised.has('search_knowledge'));
  // The tab CONTEXT.md tool catalog USED to inject these ungranted tools into the
  // prompt as usable steps, so the model attempted them at run time. None may be an
  // advertised (callable) entry now.
  for (const leak of ['build_gold_join', 'run_quality_checks', 'index_knowledge', 'create_software', 'transform_silver', 'ingest_dataset']) {
    assert.ok(!advertised.has(leak), `${leak} must not be advertised as callable — it is not granted`);
  }
  // The whole-tab golden-path text (which named cross-tab, ungranted tools verbatim
  // and led the model to attempt them) is gone — create_software lives in the software
  // tab, so a data+knowledge team must never even see the string.
  assert.doesNotMatch(pre, /create_software/, 'no cross-tab tool string may leak into the preamble');
  // The preamble carries NO artifact catalog: no ungranted dataset/knowledge NAMES
  // (the model discovers only what its granted, DLS-scoped list_* tools return).
  assert.doesNotMatch(pre, /Northpeak Employees/i, 'no ungranted dataset name may be injected');
});

test('osPreamble fails closed — a system with NO tools advertises none (not the whole catalog)', () => {
  const noTools = parseSystem({
    version: '1',
    system: { name: 'Empty', domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'a',
    grants: { tools: [] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  const pre = osPreamble(CREATOR, noTools);
  assert.match(pre, /been granted NO tools/);
  for (const leak of ['build_gold_join', 'create_software', 'query_data', 'search_knowledge']) {
    assert.doesNotMatch(pre, new RegExp(leak), `${leak} must not leak into a no-grant preamble`);
  }
});

// --- LIVE PROGRESS (0.1.81): runOsTeam forwards the streaming callbacks ----------

test('runOsTeam: forwards ordered node-started / tool-step / node-completed events (the stream source)', async () => {
  const deps = spyDeps();
  const events: { kind: string; node: string; extra?: unknown }[] = [];
  const res = await runOsTeam({
    runId: `run-test-2`,
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
    runId: `run-test-3`,
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
  assert.deepEqual(t.output, { reachedEnd: true, path: res.path });
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
      runId: `run-test-4`,
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
    runId: `run-test-5`,
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

// --- M2: the PRODUCTION hold wiring (review) ---------------------------------------------------
//
// Every other hold test drives `holdDecisionFor`, the executor with `holdAt: 'executor'`, or the
// parity harness's own copy of the wiring. Nothing ran the wiring `runOsTeam` actually ships —
// `holdAt: 'node'` on the executor (so gate 1b steps aside) plus `hold.decide` on the graph — so
// replacing `decide` with `() => ({ held: false })` left the whole suite green while every held
// write in production ran unheld. This is that test: it fails under exactly that mutation.

function deployerYaml(preset: 'read-propose' | 'full-in-scope'): string {
  return serializeSystem(
    parseSystem({
      version: '1',
      system: { name: 'Shipper', domain: 'sales', visibility: 'Personal' },
      runtime: 'langgraph',
      safety_preset: preset,
      entrypoint: 'deployer',
      grants: { tools: ['request_deploy'] },
      agents: [{ id: 'deployer', role: 'agent', agent_md: 'You request the deploy.', memory_md: '' }],
    }),
  );
}

const BUILDER: CurrentUser = { id: 'u-builder', name: 'Bo Builder', domains: ['sales'], role: 'builder' };

for (const preset of ['read-propose', 'full-in-scope'] as const) {
  test(`runOsTeam (production wiring, ${preset}): request_deploy PARKS the run — filed once, never dispatched`, async () => {
    const deps = spyDeps();
    const port = memoryApprovalPort();
    const interrupts: { approvalId: string; tool: string; node: string }[] = [];
    const res = await runOsTeam({
      runId: `run-hold-${preset}`,
      user: BUILDER,
      yaml: deployerYaml(preset),
      systemId: 'sys-ship',
      messages: [{ role: 'user', content: 'Ship it.' }],
      llm: toolCallingLlm('request_deploy'),
      toolDeps: deps,
      approvalPort: port,
      onInterrupt: (ev) => interrupts.push(ev),
      maxIterations: 3,
    });

    assert.equal(deps.calls.handleRpc.length, 0, 'a held write is never dispatched — not even once');
    assert.equal(res.parked, true, 'the run is parked, not finished');
    assert.equal(res.reachedEnd, false);
    const held = port.all();
    assert.equal(held.length, 1, 'exactly one approval is filed');
    assert.equal(held[0].tool, 'request_deploy');
    assert.equal(held[0].node, 'deployer');
    assert.equal(held[0].approverRole, 'domain_admin', 'always-confirmed: the domain gate, whatever the preset');
    assert.equal(held[0].domain, 'sales');
    assert.equal(held[0].runner.id, BUILDER.id, 'attributed to the runner, who cannot confirm it');
    assert.equal(held[0].status, 'pending');
    assert.deepEqual(res.heldApprovals?.map((h) => h.tool), ['request_deploy']);
    assert.deepEqual(interrupts.map((i) => i.tool), ['request_deploy'], 'the route is told the run parked');
  });
}

test('runOsTeam (production wiring): a My-scope write under the same preset is NOT parked — the hold is per tool', async () => {
  // The control for the test above: same wiring, same preset, a personal-scope write. If the
  // park above came from anything but the per-tool rule, this would park too.
  const deps = spyDeps();
  const port = memoryApprovalPort();
  const yaml = serializeSystem(
    parseSystem({
      version: '1',
      system: { name: 'Maker', domain: 'sales', visibility: 'Personal' },
      runtime: 'langgraph',
      safety_preset: 'read-propose',
      entrypoint: 'maker',
      grants: { tools: ['create_software'] },
      agents: [{ id: 'maker', role: 'agent', agent_md: 'You create the app.', memory_md: '' }],
    }),
  );
  const res = await runOsTeam({
    runId: 'run-hold-control',
    user: BUILDER,
    yaml,
    systemId: 'sys-make',
    messages: [{ role: 'user', content: 'Make it.' }],
    llm: toolCallingLlm('create_software'),
    toolDeps: deps,
    approvalPort: port,
    maxIterations: 3,
  });
  assert.equal(port.all().length, 0);
  assert.equal(res.parked ?? false, false);
  assert.deepEqual(deps.calls.handleRpc.map((c) => c.name), ['create_software']);
});

// --- H1: the Software Team panel's tool door ---------------------------------------------------
//
// `runPhaseTurn` is what POST /api/software/team runs: ONE agent per turn, chosen by the phase
// router, executing as the present user. It used to hand the model that agent's tool specs and
// then execute through the WHOLE Software-tab executor — and `runAgentic` does not check a call
// against the specs it offered. So `decide_deploy` / `promote` / `delete` / `archive` were one
// model-emitted tool call away from being dispatched under the user's name.

/** An executor spy standing in for `tabToolExecutor(user,'software')` — records what got through. */
function innerSpy(): { exec: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>; calls: string[] } {
  const calls: string[] = [];
  return { calls, exec: async (name) => { calls.push(name); return { text: `{"ok":true,"tool":"${name}"}`, isError: false }; } };
}

/** A model that ignores what it was offered and calls `name` on its first act. */
function insistentLlm(name: string, seenTools: string[][] = []): LlmCall {
  let acts = 0;
  return async (req) => {
    if (!req.tools || req.tools.length === 0) return { content: 'plan', toolCalls: [] };
    seenTools.push(req.tools.map((t) => t.function.name));
    acts += 1;
    if (acts === 1) return { content: '', toolCalls: [{ id: 'c1', name, args: { appId: 'app_1', decision: 'approve' } }] };
    return { content: 'done', toolCalls: [] };
  };
}

const PANEL_USER: CurrentUser = { id: 'u-panel', name: 'Ada Admin', domains: ['platform'], role: 'admin' };

/** Put the persisted per-user session in `phase` (the router reads it; a fresh one is `intake`). */
function inPhase(phase: 'build' | 'deploy' | 'feedback'): void {
  resetSession(PANEL_USER.id);
  saveSession(PANEL_USER.id, { phase, appId: 'app_1', planApproved: true, updatedAt: new Date().toISOString() });
}

for (const forbidden of ['decide_deploy', 'promote', 'decide_approval', 'promote_connection']) {
  test(`Team panel: a model emitting ${forbidden} is REFUSED and nothing is dispatched — even for an admin`, async () => {
    inPhase('build'); // the builder turn: create_software, commit, use_*
    const inner = innerSpy();
    const turn = await runPhaseTurn({
      user: PANEL_USER,
      yaml: SOFTWARE_TEAM_YAML,
      messages: [{ role: 'user', content: 'build it' }],
      llm: insistentLlm(forbidden),
      callTool: inner.exec,
    });
    assert.deepEqual(inner.calls, [], `${forbidden} must never reach the governed dispatch`);
    assert.deepEqual(turn.steps, [{ tool: forbidden, isError: true }]);
  });
}

for (const unoffered of ['delete', 'archive', 'request_deploy', 'push_app_files']) {
  test(`Team panel: ${unoffered} is not offered to the builder turn, so it is refused and not dispatched`, async () => {
    inPhase('build');
    const inner = innerSpy();
    const seen: string[][] = [];
    const turn = await runPhaseTurn({
      user: PANEL_USER,
      yaml: SOFTWARE_TEAM_YAML,
      messages: [{ role: 'user', content: 'build it' }],
      llm: insistentLlm(unoffered, seen),
      callTool: inner.exec,
    });
    assert.ok(seen.length > 0 && seen.every((names) => !names.includes(unoffered)), 'it was never offered');
    assert.deepEqual(inner.calls, [], 'an un-offered tool is not dispatched');
    assert.deepEqual(turn.steps, [{ tool: unoffered, isError: true }]);
  });
}

test('Team panel: the turn\'s OWN tool still runs — the door is an allow-list, not a wall', async () => {
  inPhase('build');
  const inner = innerSpy();
  const turn = await runPhaseTurn({
    user: PANEL_USER,
    yaml: SOFTWARE_TEAM_YAML,
    messages: [{ role: 'user', content: 'build it' }],
    llm: insistentLlm('commit'),
    callTool: inner.exec,
  });
  assert.deepEqual(inner.calls, ['commit']);
  assert.deepEqual(turn.steps, [{ tool: 'commit', isError: false }]);
});

test('Team panel, STATED AS IT IS: in the deploy phase request_deploy executes at once as the present user — this door has NO hold', async () => {
  // Not an endorsement — a record. The engine path parks `request_deploy` for a second person
  // (see the production-wiring test above). This interactive panel is a synchronous turn with no
  // checkpoint to park on; the user reaches the deploy phase by typing a "ship it"-style phrase
  // and the deployer's one offered tool then runs under their own role gates. Whether that typed
  // phrase is confirmation enough is an open product decision (os-ui/ARCHITECTURE.md). If a hold
  // is added here, this test is the one that must change.
  inPhase('deploy');
  const inner = innerSpy();
  const seen: string[][] = [];
  const turn = await runPhaseTurn({
    user: PANEL_USER,
    yaml: SOFTWARE_TEAM_YAML,
    messages: [{ role: 'user', content: 'ship it' }],
    llm: insistentLlm('request_deploy', seen),
    callTool: inner.exec,
  });
  assert.deepEqual(seen[0], ['request_deploy'], 'the deployer is offered exactly one tool');
  assert.deepEqual(inner.calls, ['request_deploy']);
  assert.equal(turn.role, 'deployer');
  resetSession(PANEL_USER.id);
});

test('phaseToolExecutor: a forbidden name is refused even when a yaml OFFERS it; prototype names are just un-offered', async () => {
  const inner = innerSpy();
  const exec = phaseToolExecutor(inner.exec, ['commit', 'decide_deploy']);
  const refused = await exec('decide_deploy', {});
  assert.equal((JSON.parse(refused.text) as { error: { code: string } }).error.code, 'forbidden');
  for (const name of ['constructor', 'toString', '__proto__', '']) {
    const r = await exec(name, {});
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, 'not_found', `${name || '(empty)'} is simply not offered`);
  }
  assert.deepEqual(inner.calls, []);
  assert.equal((await exec('commit', {})).isError, false);
  assert.deepEqual(inner.calls, ['commit']);
});

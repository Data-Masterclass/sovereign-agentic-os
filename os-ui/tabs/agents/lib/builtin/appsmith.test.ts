/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The `os.appsmith` built-in system, driven through the REAL engine by a scripted LLM
 * USER STORY: As the engineer who claims the builder now recovers from a failed compile I want that
 *             proved on the actual LangGraph engine with the actual governed tool gates — not on a
 *             mock of them.
 * ARCHITECTURE:
 *   - PARITY-STYLE fixture (`./fixtures/builtin-appsmith.json`): the yaml, the script id,
 *     the scenario and the frozen golden (path · tool calls · reached-end). The gates
 *     (`grantedToolSpecs` / `grantedToolExecutor`) and the engine are REAL; only the model and the
 *     MCP dispatch are faked, exactly as `parity-harness.ts` does it. It lives HERE and not in
 *     `../engine/fixtures/` because that directory is the FROZEN record of the deleted pre-rebuild
 *     walker: `parity.test.ts` replays every file in it from a recorded `transcript`, and this
 *     system never ran under the walker, so it has none (deviation H-5/H-11).
 *   - THE SCENARIO is the stream's whole claim: the coder's FIRST `commit` is rejected by the
 *     compile gate (a typed 422 — nothing written), the diagnostics come back as the tool result,
 *     and the SECOND commit lands. Then the reviewer scores the stories and the run ends.
 *   - The engine's own per-node round cap is raised for this fixture (the coder legitimately needs
 *     four rounds); everything else is wired exactly as the harness wires production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import type { LlmCall } from '@core/runtime/agentic';
import { SET_STATE_TOOL_NAME } from '../engine/build-graph.ts';
import { memoryCheckpointer } from '../engine/checkpointer.ts';
import { runGraphEngine } from '../engine/run.ts';
import { graphDeps, nodeOfRequest, stepOutcome, type GoldenToolCall, type HoldSink } from '../engine/parity-harness.ts';
import { holdDecisionFor, isWriteTool, writeTargetScope } from '../build/hold.ts';
import { WRITE_TOOL_TABS } from '@core/mcp/write-tool-meta';
import { APPSMITH_CHANNELS, APPSMITH_MAX_ITERATIONS, APPSMITH_SYSTEM_ID, APPSMITH_YAML } from './appsmith.ts';

const FIXTURE_PATH = join(process.cwd(), 'tabs', 'agents', 'lib', 'builtin', 'fixtures', 'builtin-appsmith.json');

type Fixture = {
  version: 1;
  name: string;
  source: string;
  description: string;
  task: string;
  script: string;
  yaml: string;
  scenario: { commitAttempts: number; firstCommitRejection: string };
  golden: { path: string[]; toolCalls: GoldenToolCall[]; reachedEnd: boolean; held: number };
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/** The diagnostics the compile gate returns on the coder's first attempt. */
const GATE_REJECTION =
  'commit rejected: 1 compile error — NOTHING was written.\n' +
  "  src/epics/e1/s1/Page.tsx:1:10  TS2305: Module '\"@sovereign-os/ui\"' has no exported member 'Modal'.";

/**
 * The scripted model for this fixture. Per node, keyed on the engine's own role marker:
 *   • planner  → set plan_ready, then FINAL;
 *   • coder    → commit (rejected), commit (accepted), set build_ok, then FINAL;
 *   • reviewer → set stories_passed, then FINAL.
 */
function appsmithScript(): LlmCall {
  const acts = new Map<string, number>();
  return async (req) => {
    const node = nodeOfRequest(req);
    if (!req.tools) return { content: `plan(${node}): ground, build, score.`, toolCalls: [] };
    const n = (acts.get(node) ?? 0) + 1;
    acts.set(node, n);
    const call = (name: string, args: Record<string, unknown>) => ({
      content: '',
      toolCalls: [{ id: `${node}-${n}`, name, args }],
    });
    if (node === 'planner') {
      if (n === 1) return call(SET_STATE_TOOL_NAME, { channel: 'plan_ready', value: true });
      return { content: 'FINAL(planner): one page, reading ds_1, satisfying e1/s1.', toolCalls: [] };
    }
    if (node === 'coder') {
      if (n === 1 || n === 2) return call('commit', { appId: 'app_1', files: [{ path: 'src/epics/e1/s1/Page.tsx', content: '…' }], message: 'build e1/s1' });
      if (n === 3) return call(SET_STATE_TOOL_NAME, { channel: 'build_ok', value: true });
      return { content: 'FINAL(coder): the tree compiles and 1 file is committed.', toolCalls: [] };
    }
    if (node === 'reviewer') {
      if (n === 1) return call(SET_STATE_TOOL_NAME, { channel: 'stories_passed', value: true });
      return { content: 'FINAL(reviewer): every machine-decidable check passed; 1 NFR is for the human.', toolCalls: [] };
    }
    return { content: `FINAL(${node}).`, toolCalls: [] };
  };
}

/** Drive the system through the real engine with the scripted model and a faked MCP dispatch. */
async function run(): Promise<{
  path: string[];
  toolCalls: GoldenToolCall[];
  finalText: string;
  reachedEnd: boolean;
  held: number;
  commitArgs: Record<string, unknown>[];
}> {
  const sys = parseSystem(fixture.yaml);
  const ir = compile(sys);
  const sink: HoldSink = { enqueued: [] };
  const toolCalls: GoldenToolCall[] = [];
  const commitArgs: Record<string, unknown>[] = [];
  let commits = 0;
  const base = graphDeps(sys, `fixture-${fixture.name}`, appsmithScript(), sink, {
    handlers: {
      // The GOVERNED file-write door, faked at the MCP boundary only: the compile gate rejects
      // the first attempt with a typed error (nothing written) and accepts the second.
      commit: (args) => {
        commits += 1;
        commitArgs.push(args);
        if (commits === 1) throw new Error(GATE_REJECTION);
        return { ok: true, committed: 1, gate: { gated: true, ok: true } };
      },
    },
  });
  // The coder legitimately needs four rounds (reject → fix → record → report); the harness's
  // default per-node cap is four, so raise it rather than write a scenario around the cap.
  const deps = { ...base, maxIterations: 8 };
  const result = await runGraphEngine({
    ir,
    deps,
    messages: [{ role: 'user', content: fixture.task }],
    runId: `fixture-${fixture.name}`,
    checkpointer: memoryCheckpointer(),
    hooks: {
      onStep: (ev) => {
        toolCalls.push({ node: ev.node, tool: ev.step.tool, args: ev.step.args, outcome: stepOutcome(ev.step) });
      },
    },
  });
  return {
    path: result.path,
    toolCalls,
    finalText: result.finalText,
    reachedEnd: result.reachedEnd,
    held: sink.enqueued.length + (sink.port?.all().length ?? 0),
    commitArgs,
  };
}

test('H7 the os.appsmith yaml parses, compiles, and declares the loop the harness documents', () => {
  const sys = parseSystem(APPSMITH_YAML);
  assert.equal(sys.system.name, 'App Smith');
  assert.deepEqual(sys.agents.map((a) => a.id), ['planner', 'coder', 'reviewer']);
  // Every routing channel is DECLARED, which is what lets an agent write it with os_set_state.
  for (const ch of APPSMITH_CHANNELS) assert.equal(sys.state.channels[ch], 'boolean', `channel ${ch}`);
  // The three guarded handoffs, including the reviewer's loop-back to the coder.
  const handoffs = sys.edges.filter((e) => e.type === 'handoff').map((e) => `${e.from}->${e.to}:${e.when}`);
  assert.deepEqual(handoffs, ['planner->coder:plan_ready', 'coder->reviewer:build_ok', 'reviewer->coder:stories_failed']);
  // `commit` IS the build tool (the compile gate runs inside it); `decide_deploy` is NOT granted.
  assert.ok(sys.grants.tools.includes('commit'));
  assert.ok(!sys.grants.tools.includes('decide_deploy'), 'a run may never approve its own go-live');
  assert.equal(APPSMITH_SYSTEM_ID, 'os.appsmith');
  assert.equal(APPSMITH_MAX_ITERATIONS, 4);
  // It compiles to a graph with a node per agent.
  const ir = compile(sys);
  assert.equal(ir.nodes.length, sys.agents.length);
});

test('the frozen fixture carries the shipped yaml', () => {
  assert.equal(fixture.yaml, APPSMITH_YAML, 'the fixture must record the yaml that actually ships');
  assert.equal(fixture.scenario.commitAttempts, 2);
});

test('H9 the engine run RECOVERS: the first commit is rejected, the second lands', async () => {
  const r = await run();
  // The rejected call is recorded as an ERROR step and the accepted one as ok — in that order.
  const commits = r.toolCalls.filter((c) => c.tool === 'commit');
  assert.equal(commits.length, 2, 'exactly two commit attempts');
  assert.equal(commits[0].outcome, 'error', 'the first commit must be REJECTED by the gate');
  assert.equal(commits[1].outcome, 'ok', 'the second commit must land');
  assert.equal(r.commitArgs.length, 2);
  // The loop advanced on EVIDENCE: the guards fired, so the path is planner -> coder -> reviewer.
  assert.deepEqual(r.path, fixture.golden.path);
  assert.equal(r.reachedEnd, fixture.golden.reachedEnd);
  assert.ok(r.finalText.includes('check passed'), r.finalText);
});

test('the run matches the frozen golden tool-call sequence', async () => {
  const r = await run();
  assert.deepEqual(
    r.toolCalls.map((c) => `${c.node}:${c.tool}:${c.outcome}`),
    fixture.golden.toolCalls.map((c) => `${c.node}:${c.tool}:${c.outcome}`),
  );
  assert.equal(r.held, fixture.golden.held);
});

// -------------------------------- H-1: the hold posture of the build tool ----------
//
// `commit` writes an app's SOURCE FILES and is a PLATFORM-MCP write tool, so it lives outside
// `ALL_WRITE_TOOLS`. It was MISSING from `core/mcp/write-tool-meta.ts`, which is the table the
// agent hold gate reads — so `holdDecisionFor(preset,'commit')` answered "not a write" under
// EVERY preset and a `read-only` agent granted `commit` could write app files unheld. This pins
// the fix AND the resulting posture, so `held: 0` in the golden above is a stated decision rather
// than an accident. It must hold before `os.appsmith` is ever seeded.

test('H-1 `commit` is a WRITE tool the hold gate can see', () => {
  assert.ok(isWriteTool('commit'), 'commit must be in WRITE_TOOL_TABS or no preset can hold it');
  assert.equal(WRITE_TOOL_TABS.commit, 'software');
});

test('H-1 posture: read-only HOLDS the build tool; the other presets do not, by design', () => {
  // read-only: every write is blocked and queued to an admin. This is the bug that is now fixed —
  // before `commit` was in the table this returned `{ held: false }`.
  assert.deepEqual(holdDecisionFor('read-only', 'commit'), { held: true, approverRole: 'admin' });

  // read-propose / full: `commit` writes the RUNNER'S OWN app (a My-scope artifact), and
  // `writeTargetScope` classifies it `personal`. The OS's security invariant is that an agent never
  // exceeds what its runner could do BY HAND, and a builder has full rights over their own app — so
  // gate 2 (the run-as-user governed dispatch: OPA, DLS, role, ownership) is the authority, not a
  // hold. THIS is why the fixture's golden records `held: 0` under `read-propose`: the commits were
  // executed as the signed-in user, and the compile gate — not an approval queue — is what rejected
  // the first one. A go-live still needs a human: `decide_deploy` is not granted at all.
  assert.deepEqual(holdDecisionFor('read-propose', 'commit'), { held: false });
  assert.equal(writeTargetScope('commit'), 'personal');
  assert.equal(parseSystem(APPSMITH_YAML).safetyPreset, 'read-propose');
  assert.equal(fixture.golden.held, 0, 'deliberate: a personal-scope write is not held — see above');
});

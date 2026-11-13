/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    The agent-run surface over MCP — one sequence, one door, one owner gate
 * USER STORY: As an MCP client I want to drive a whole agent run — build → run → follow → decide
 *             an approval → resume after a restart → read the trace — with the tools the OS
 *             advertises, and I want a run id I do not own to be indistinguishable from one that
 *             does not exist.
 * ARCHITECTURE:
 *   - Catalogue + semantics: the five tools exist, floor at the right role, carry worked examples,
 *     and their DESCRIPTIONS name the real sequence (this is what `list_capabilities` hands an AI,
 *     so a wrong description is a wrong product).
 *   - Behaviour over the real dispatcher (`handleRpc`): an unknown run id is `not_found` from
 *     every run-addressed tool — never `forbidden`, never an empty success, never a 500.
 *   - SOURCE TRIPWIRES for what a unit test cannot reach here: every run-addressed door calls
 *     `assertRunVisible` BEFORE any side effect or any read, and `get_agent_run` tails
 *     `run_events` with `afterSeq` rather than re-reading the whole run. The gate's own
 *     semantics (owner mismatch, wrong system, missing row → 404) are proven in
 *     `tabs/agents/lib/engine/run-visibility.test.ts`; what these tripwires pin is that each
 *     door actually goes through it — the A4-review-H-1 defect was a missing CALL, not a wrong
 *     gate.
 *   - Imports NO tab (CORE-INDEPENDENCE): the tab-owned state these tools read is reached through
 *     the dispatcher, exactly as a client reaches it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, ALL_MCP_TOOLS, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { __resetApprovals } from '@core/policy/approvals';

const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** The run id shape `newRunId()` mints — valid, and guaranteed not to exist. */
const GHOST = 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427';

// ---- the sequence the OS advertises -------------------------------------------

test('the agent-run surface is five tools, correctly classified, each with worked examples', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writes = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  const expected: { name: string; write: boolean; minRole: string }[] = [
    { name: 'run_agent_system', write: true, minRole: 'creator' },
    { name: 'resume_agent_run', write: true, minRole: 'creator' },
    { name: 'get_agent_run', write: false, minRole: 'creator' },
    { name: 'list_runs', write: false, minRole: 'creator' },
    { name: 'get_run_trace', write: false, minRole: 'creator' },
  ];
  for (const e of expected) {
    const t = byName.get(e.name);
    assert.ok(t, `${e.name} missing from ALL_MCP_TOOLS`);
    assert.equal(t!.minRole, e.minRole, `${e.name} floors at ${e.minRole}`);
    assert.equal(writes.has(e.name), e.write, `${e.name} write-classified as ${e.write}`);
    assert.ok((t!.inputSchema.examples ?? []).length >= 1, `${e.name} carries ≥1 worked example`);
  }
  // decide_approval is the sixth door, but it belongs to governance and floors higher.
  assert.equal(byName.get('decide_approval')!.minRole, 'builder');
});

test('the descriptions name the real sequence: build → run → follow → approve → resume → trace', () => {
  const by = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t.description]));
  // run_agent_system points FORWARD to every follow-up, and says what a runId is.
  const run = by.get('run_agent_system')!;
  for (const next of ['get_agent_run', 'decide_approval', 'resume_agent_run', 'get_run_trace']) {
    assert.match(run, new RegExp(next), `run_agent_system names ${next}`);
  }
  assert.match(run, /thread id AND the Langfuse trace id/i, 'runId = thread id = trace id is stated, not implied');
  assert.match(run, /PARKS/, 'and that a held write parks the run instead of executing');
  // get_agent_run advertises the incremental tail.
  assert.match(by.get('get_agent_run')!, /afterSeq/);
  assert.match(by.get('get_agent_run')!, /not_found/, 'and that a foreign run id is not_found');
  // resume is NOT the way to continue a parked run — the approval is.
  assert.match(by.get('resume_agent_run')!, /NOT for a run parked on an approval/i);
  // decide_approval says the runner executes, not the approver.
  assert.match(by.get('decide_approval')!, /RESUMES that run/);
  assert.match(by.get('decide_approval')!, /as the RUNNER, not as you/);
  // the trace is one run's trace, by run id.
  assert.match(by.get('get_run_trace')!, /trace id IS the run id/i);
  // No tool advertises an engine choice any more — there is one engine.
  for (const [name, d] of by) assert.doesNotMatch(d, /AGENTS_ENGINE|runtime: walker/, `${name} must not advertise an engine flag`);
});

test('the agents guide teaches that same sequence, in order', () => {
  const guide = readFileSync(new URL('../../tabs/agents/guide.md', import.meta.url), 'utf8');
  const order = ['build_agent_system', 'run_agent_system', 'get_agent_run', 'decide_approval', 'resume_agent_run', 'get_run_trace'];
  let at = -1;
  for (const step of order) {
    const found = guide.indexOf(step, at + 1);
    assert.ok(found > at, `${step} appears after the previous step in the guide`);
    at = found;
  }
  assert.doesNotMatch(guide, /hermes|walker|AGENTS_ENGINE/, 'the guide must not teach a retired engine');
});

// ---- a run id is a capability, not an index ----------------------------------

test('an unknown run id is not_found from every run-addressed tool (never forbidden, never empty)', async () => {
  __resetApprovals();
  for (const name of ['get_agent_run', 'resume_agent_run']) {
    const e = errorOf(await call(creator, name, { runId: GHOST }));
    assert.equal(e.code, 'not_found', `${name} on an unknown run`);
  }
  // A5-review-M-1: `get_run_trace` on an AGENT run id is the OWNER gate, not the scope gate, so
  // the answer is not_found — never forbidden (which would confirm the run exists), never a
  // successful read of somebody else's trace.
  const trace = await call(creator, 'get_run_trace', { runId: GHOST });
  assert.equal(trace.isError, true, 'an unknown agent run id is an error, not an empty success');
  assert.equal(errorOf(trace).code, 'not_found', 'owner-gated: 404 both ways');
});

test('list_runs is hard-scoped to the caller and says so in its payload', async () => {
  const out = payload<{ scope: { level: string }; runs: unknown[] }>(await call(creator, 'list_runs', { limit: 5 }));
  assert.ok(out.scope.level, 'every listing states the scope it was filtered to');
  assert.ok(Array.isArray(out.runs));
  assert.ok(out.runs.length <= 5, 'the cap is honoured');
});

// ---- tripwires: every door goes through the owner gate -----------------------

test('TRIPWIRE: every run-addressed door calls assertRunVisible, and does it FIRST', () => {
  const doors: { file: string; fn?: string }[] = [
    { file: 'core/mcp/discovery-base-tools.ts', fn: 'get_agent_run' },
    { file: 'core/mcp/agent-write-tools.ts', fn: 'resume_agent_run' },
    { file: 'app/api/agents/systems/[id]/run/route.ts' },
    { file: 'app/api/agents/systems/[id]/run/stream/route.ts' },
    { file: 'app/api/agents/systems/[id]/run/diagnostics/route.ts' },
    // A5-review-M-3: the judge route takes a `runId` from the body and writes a SCORE on that
    // run's Langfuse trace, so it is a run-addressed door like the others.
    { file: 'app/api/agents/systems/[id]/evaluate/route.ts' },
    // A5-review-M-1: the monitoring trace read is owner-gated for an agent run id.
    { file: 'core/mcp/monitoring-tools.ts' },
  ];
  for (const d of doors) {
    const text = src(d.file);
    assert.match(text, /assertRunVisible/, `${d.file} must gate on the run's owner`);
    // …and before anything that mutates or streams: the A4-review-H-1 defect was a gate that
    // fired AFTER the row had been re-queued and the history had already streamed.
    const gate = text.indexOf('assertRunVisible(');
    for (const sideEffect of ['enqueueRun(', 'resumeQueuedRun(', 'readObservations(', 'tailRunEvents(', 'eventsAfter(', 'scoreTrace(', 'fetchTrace(']) {
      const at = text.indexOf(sideEffect);
      if (at >= 0) assert.ok(gate >= 0 && gate < at, `${d.file}: the owner gate must precede ${sideEffect}`);
    }
  }
});

test('TRIPWIRE: get_agent_run tails run_events incrementally (afterSeq), not by re-reading the run', () => {
  const text = src('core/mcp/discovery-base-tools.ts');
  assert.match(text, /eventsAfter\(runId, afterSeq/, 'the tail is a bounded read from a cursor');
  assert.match(text, /nextSeq/, 'and hands the caller the cursor to continue from');
});

test('TRIPWIRE: no Langfuse run trace is created without a run id, and no link is a LIST', () => {
  // The observer's trace id IS the run id — there is no other way to construct one.
  const obs = src('tabs/agents/lib/engine/observe.ts');
  assert.match(obs, /const traceId = input\.runId;/, 'the trace id is the run id, by construction');
  assert.match(obs, /client\.trace\(\{\s*id: traceId,/, 'and the only trace-create uses it');
  // The deep link refuses to build without one, and nothing builds a /traces list link.
  const lf = src('core/infra/langfuse.ts');
  assert.match(lf, /if \(!base \|\| !runId\) return undefined;/, 'traceUrlFor refuses without a run id');
  for (const file of ['core/infra/langfuse.ts', 'tabs/agents/lib/build/server.ts', 'tabs/agents/lib/build/run-service.ts']) {
    assert.doesNotMatch(src(file), /\/traces(["'`]|\$)/, `${file} must not link to a trace LIST (checklist A20)`);
  }
});

test('TRIPWIRE: an embedding never silently substitutes hash vectors on the agent path', () => {
  // A31: the fallback must be LABELLED (`offline-hash`) and a 4xx must throw, in both embedders.
  // Each embedder LABELS its substitute vectors in its own result shape (`source: 'offline-hash'`
  // for knowledge, `mode: 'mock'` for files) and THROWS on a 4xx instead of indexing them.
  for (const [file, label] of [
    ['tabs/knowledge/lib/embed.ts', /source: 'offline-hash'/],
    ['tabs/files/lib/embed.ts', /mode: 'mock'/],
  ] as const) {
    const text = src(file);
    assert.match(text, label, `${file} labels the fallback in its result`);
    assert.match(text, /isClientRejection/, `${file} distinguishes a client rejection…`);
    assert.match(text, /throw/, `…and throws rather than substituting on one`);
  }
  // And the Context Librarian refuses to curate over those vectors at all.
  assert.match(
    src('tabs/agents/lib/build/agentic-graph.ts'),
    /deps\.embedSource\?\.\(\) !== 'offline-hash'/,
    'relevance curation is skipped when the vectors are semantically empty',
  );
});

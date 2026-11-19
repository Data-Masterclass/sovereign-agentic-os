/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A run's report says truthfully how it ended (F15)
 * USER STORY: As the person who started a run I want "failed" to read failed everywhere — the
 *             report every door returns, the stored last run, the Monitoring run list — so a
 *             run whose agent failed never shows as done or green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import type { LlmCall } from '@core/runtime/agentic';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { finalizeTeamRun } from '@tabs/agents/lib/build/run-service';
import { outputFailed } from '@tabs/monitoring/lib/adapters/run-trace';

const USER: CurrentUser = { id: 'u1', name: 'Cara', domains: ['sales'], role: 'creator' };

const YAML = serializeSystem(parseSystem({
  version: '1',
  system: { name: 'Two', domain: 'sales', visibility: 'Personal' },
  entrypoint: 'reader',
  grants: { tools: ['search_knowledge'] },
  agents: [
    { id: 'reader', role: 'reads', agent_md: 'Read.', memory_md: '' },
    { id: 'writer', role: 'writes', agent_md: 'Write.', memory_md: '' },
  ],
  edges: [{ from: 'reader', to: 'writer', type: 'handoff' }],
}));

type TraceCall = Parameters<OsToolDeps['trace']>[0];
function deps(traces: TraceCall[]): OsToolDeps {
  return {
    enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
    handleRpc: (async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })) as OsToolDeps['handleRpc'],
    trace: (async (ev: TraceCall) => { traces.push(ev); return {} as never; }) as OsToolDeps['trace'],
  };
}

/** `reader` answers; `writer` throws in ACT when `fail` is set. */
function llm(fail: boolean): LlmCall {
  return async (req) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (/Output only the plan/.test(system)) return { content: 'plan', toolCalls: [] };
    if (fail && /YOUR ROLE IN THE TEAM: writer /.test(system)) throw new Error('LiteLLM 503: upstream unavailable');
    return { content: 'done', toolCalls: [] };
  };
}

async function runTeam(fail: boolean) {
  const traces: TraceCall[] = [];
  const team = await runOsTeam({ runId: `run-report-${fail}`, user: USER, yaml: YAML, systemId: 'sys-two', messages: [{ role: 'user', content: 'go' }], llm: llm(fail), toolDeps: deps(traces) });
  await new Promise((r) => setTimeout(r, 0));
  return { team, traces, ...finalizeTeamRun(team, false, YAML) };
}

test('F15: a run ended by an agent failure — the report, the stored last run and the summary trace all say FAILED', async () => {
  const { body, lastRun, traces } = await runTeam(true);
  // The report every door returns (UI `done` frame, MCP run_agent_system, the scheduler).
  assert.equal(body.failed, true);
  assert.equal(body.status, 'failed');
  assert.deepEqual(body.failure, { node: 'writer', reason: 'LiteLLM 503: upstream unavailable' });
  assert.equal(body.ok, false);
  assert.equal(body.reachedEnd, false);
  // The stored last run (the Agents list and the Monitoring agent tile read `ok`).
  assert.equal(lastRun.ok, false);
  assert.equal(lastRun.failed, true);
  assert.equal(lastRun.failureReason, 'LiteLLM 503: upstream unavailable');
  assert.equal(lastRun.failedNode, 'writer');
  // The Monitoring RUN LIST reads the run-summary trace: it was green for a failed run.
  const summary = traces.find((t) => t.principal === 'os-sys-two:run');
  assert.ok(summary, 'the run-summary trace was emitted');
  assert.equal(outputFailed(summary!.output), true, 'the run list reads this run as failed (red)');
  assert.deepEqual(summary!.output, { reachedEnd: false, path: ['reader', 'writer'], failed: true, failedNode: 'writer', reason: 'LiteLLM 503: upstream unavailable' });
});

test('F15: a run that completed is unchanged — done, ok, and its summary trace carries no failure flag', async () => {
  const { body, lastRun, traces } = await runTeam(false);
  assert.equal(body.failed, false);
  assert.equal(body.status, 'done');
  assert.equal(body.failure, undefined);
  assert.equal(body.ok, true);
  assert.equal(lastRun.failed, undefined);
  const summary = traces.find((t) => t.principal === 'os-sys-two:run')!;
  assert.deepEqual(summary.output, { reachedEnd: true, path: ['reader', 'writer'] });
  assert.equal(outputFailed(summary.output), false);
});

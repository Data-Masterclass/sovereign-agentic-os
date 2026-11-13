/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    LiteLLM attribution on a real engine run (checklist A25, A27, A24)
 * USER STORY: As a finance owner I can ask the gateway what one run cost, because EVERY model call of
 *             a run carried `user`, `domain:`, `agent:` and `run:` — and none carried the master key.
 * ARCHITECTURE: the REAL `liteLlmCaller` against a fetch stub that answers in the OpenAI wire shape
 *             from the scripted model, driving the REAL graph engine end to end; every outgoing body
 *             and header is asserted.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@core/kernel/config';
import { liteLlmCaller } from '@core/runtime/runtime';
import { TAG_AGENT, TAG_DOMAIN, TAG_RUN, TAG_TAB } from '@core/infra/litellm-credential';
import type { LlmRequest } from '@core/runtime/agentic';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { FIXTURE_TASK, SHAPE_SUPERVISOR_YAML, graphDeps, scriptedLlm, type HoldSink } from '@tabs/agents/lib/engine/parity-harness';
import { noopObserver, type RunObserver } from '@tabs/agents/lib/engine/observe';

type Captured = { auth: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A LiteLLM stand-in: OpenAI wire in → the scripted model → OpenAI wire out. */
function gatewayStub(captured: Captured[]) {
  const script = scriptedLlm(FIXTURE_TASK);
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    captured.push({ auth: String((init?.headers as Record<string, string>)?.authorization ?? ''), body });
    const req: LlmRequest = { model: String(body.model), messages: body.messages as LlmRequest['messages'], tools: body.tools as LlmRequest['tools'] };
    const out = await script(req);
    const message = {
      role: 'assistant',
      content: out.content,
      ...(out.toolCalls.length > 0 ? { tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
    };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** An observer that stamps a trace context on every call without needing Langfuse. */
function stampingObserver(runId: string): RunObserver {
  const base = noopObserver(runId);
  return {
    ...base,
    enabled: true,
    span: (name, metadata) => {
      const h = base.span(name, metadata);
      return { ...h, llm: (inner) => (req) => inner({ ...req, observe: { traceId: runId, parentObservationId: h.id } }) };
    },
  };
}

test('ATTRIBUTION (A27): every model call of a real engine run carries user, domain:, agent:, run: — and the scoped key (A25)', async () => {
  const captured: Captured[] = [];
  globalThis.fetch = gatewayStub(captured);
  const runId = 'run_attr0000-0000-4000-8000-000000000001';
  const sys = parseSystem(SHAPE_SUPERVISOR_YAML);
  const llm = liteLlmCaller({ userId: 'rae', domain: sys.system.domain, systemId: 'sys-attr', tab: 'agents', runId });
  const sink: HoldSink = { enqueued: [] };
  const result = await runGraphEngine({
    ir: compile(sys),
    deps: { ...graphDeps(sys, 'sys-attr', llm, sink), observe: stampingObserver(runId) },
    messages: [{ role: 'user', content: FIXTURE_TASK }],
    runId,
    checkpointer: memoryCheckpointer(),
  });
  assert.equal(result.reachedEnd, true);
  assert.ok(captured.length >= 5, `a supervisor + two members make several model calls (saw ${captured.length})`);

  for (const { auth, body } of captured) {
    assert.equal(auth, `Bearer ${config.litellmAgentKey}`, 'the scoped agent key, exactly');
    assert.notEqual(auth, `Bearer ${config.litellmMasterKey}`, 'the MASTER key reached an inference call');
    assert.equal(body.user, 'os-rae');
    const meta = body.metadata as { tags: string[]; existing_trace_id?: string; trace_id?: string; parent_observation_id?: string; trace_user_id?: string; session_id?: string };
    assert.ok(meta.tags.includes(`${TAG_DOMAIN}${sys.system.domain}`), 'domain tag');
    assert.ok(meta.tags.includes(`${TAG_AGENT}sys-attr`), 'agent tag');
    assert.ok(meta.tags.includes(`${TAG_RUN}${runId}`), 'run tag');
    assert.ok(meta.tags.includes(`${TAG_TAB}agents`), 'tab tag');
    // A24: the gateway's own Langfuse callback is told to log INTO the run trace, under the OS generation.
    assert.equal(meta.existing_trace_id, runId);
    // A4 review: `existing_trace_id` is the key LiteLLM's Langfuse callback reads. The duplicate
    // `trace_id` was dropped — two names for one id invite them to disagree.
    assert.equal(meta.trace_id, undefined, 'only existing_trace_id carries the run trace');
    assert.ok(meta.parent_observation_id, 'parent observation forwarded');
    assert.equal(meta.trace_user_id, 'rae');
    assert.equal(meta.session_id, 'sys-attr');
  }
});

test('ATTRIBUTION: a call outside a run carries no run tag and no trace context (nothing invented)', async () => {
  const captured: Captured[] = [];
  globalThis.fetch = gatewayStub(captured);
  await liteLlmCaller({ userId: 'rae', domain: 'sales', tab: 'assistant' })({ model: 'sovereign-default', messages: [{ role: 'user', content: 'ping' }] });
  const meta = captured[0].body.metadata as { tags: string[]; existing_trace_id?: string };
  assert.ok(!meta.tags.some((t) => t.startsWith(TAG_RUN)));
  assert.equal(meta.existing_trace_id, undefined);
});

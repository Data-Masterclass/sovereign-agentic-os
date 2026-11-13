/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { runOsAssistant, ASK_COST_TAB, artifactsFromToolResult } from '@core/runtime/agent-loop';
import { liteLlmCaller } from '@core/runtime/runtime';
import { config } from '@core/kernel/config';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';

/**
 * FEATURE:    One Langfuse trace per Ask-the-OS TURN (C1), and the Ask cost dimension (C-R3.2).
 *
 * USER STORY: As an operator I want a conversation turn to be ONE readable trace with its
 *             tool calls nested, instead of N unlinked traces I cannot stitch back together,
 *             and I want to be able to read back what the Ask-the-OS surface costs.
 *
 * ARCHITECTURE:
 *   Two halves, both on the real plumbing:
 *     (a) `runOsAssistant` must pass `observe: { traceId }` to EVERY model call it makes —
 *         the plan, each act iteration, and the cap synthesis. Asserted by recording the
 *         `LlmRequest`s through the injected caller.
 *     (b) `liteLlmCaller` must turn that into LiteLLM's own Langfuse metadata
 *         (`existing_trace_id` + `trace_user_id`), which is what makes the gateway's
 *         callback log INTO the turn's trace instead of creating a stray one. Asserted by
 *         recording the HTTP body with a stubbed `fetch` — the same technique the
 *         MODEL-KEY gate uses.
 *   Before this change the assistant path passed no `observe` at all, so every model call
 *   in a turn became its own orphan trace. The guard here is that `observe` is present on
 *   ALL calls, not merely on one.
 */

const creator: CurrentUser = { id: 'u-42', name: 'Robin', domains: ['sales'], role: 'creator' };

/** A scripted model that records every request, acts once, then answers. */
function recording(toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = []) {
  const reqs: LlmRequest[] = [];
  let acted = false;
  const llm: LlmCall = async (req) => {
    reqs.push(req);
    if (!req.tools) return { content: '1. plan', toolCalls: [] };
    if (toolCalls.length > 0 && !acted) {
      acted = true;
      return { content: '', toolCalls };
    }
    return { content: 'done', toolCalls: [] };
  };
  return { llm, reqs };
}

test('C1: every model call in one turn carries the SAME observe.traceId', async () => {
  const { llm, reqs } = recording([{ id: 'c1', name: 'whoami', args: {} }]);
  const res = await runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'who am I' }], llm });
  assert.ok(reqs.length >= 3, `expected plan + act + final, saw ${reqs.length}`);
  const ids = new Set(reqs.map((r) => r.observe?.traceId));
  assert.equal(ids.size, 1, `a turn must be ONE trace; saw ${[...ids].join(', ')}`);
  assert.equal([...ids][0], res.traceId, 'the returned traceId must be the one the calls carried');
  for (const r of reqs) {
    assert.ok(r.observe?.traceId, 'a model call with no observe becomes an orphan Langfuse trace');
  }
});

test('C1: the turn id is server-minted and unique per turn, never reused across turns', async () => {
  const a = await runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'x' }], llm: recording().llm });
  const b = await runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'y' }], llm: recording().llm });
  assert.notEqual(a.traceId, b.traceId, 'two turns must not share a trace id');
  assert.match(a.traceId, /^ask-/, 'the turn id is namespaced so it cannot collide with a run id');
});

test('C1: an injected traceId is honoured (the hook the durable-thread work will use)', async () => {
  const { llm, reqs } = recording();
  const res = await runOsAssistant({
    user: creator,
    tab: 'data',
    messages: [{ role: 'user', content: 'x' }],
    traceId: 'ask-fixed-0001',
    llm,
  });
  assert.equal(res.traceId, 'ask-fixed-0001');
  assert.ok(reqs.every((r) => r.observe?.traceId === 'ask-fixed-0001'));
});

test('C-R3.2: liteLlmCaller forwards observe as LiteLLM Langfuse metadata and tags the Ask surface', async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const orig = globalThis.fetch;
  const origKey = config.litellmAgentKey;
  // The caller REFUSES with no scoped credential (never the master key), so give it one.
  (config as { litellmAgentKey: string }).litellmAgentKey = 'sk-scoped-test';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await liteLlmCaller({ userId: 'u-42', domain: 'sales', tab: ASK_COST_TAB, runId: 'ask-xyz' })({
      model: 'sovereign-fast',
      messages: [{ role: 'user', content: 'ping' }],
      observe: { traceId: 'ask-xyz' },
    });
  } finally {
    globalThis.fetch = orig;
    (config as { litellmAgentKey: string }).litellmAgentKey = origKey;
  }
  const metadata = (seen.body?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.existing_trace_id, 'ask-xyz', 'without existing_trace_id the gateway starts a stray trace');
  assert.equal(metadata.trace_user_id, 'u-42');
  const tags = metadata.tags as string[];
  assert.ok(tags.includes(`tab:${ASK_COST_TAB}`), `Ask-surface cost must be readable back; saw ${tags.join(',')}`);
  assert.ok(tags.includes('run:ask-xyz'), 'the turn dimension must be on the tags');
  assert.ok(tags.includes('domain:sales'));
});

test('C-R3.2: the Ask cost dimension is its own tab value, not the tab the user happens to be on', () => {
  assert.equal(ASK_COST_TAB, 'ask');
});

// ------------------------------------------------- the chat-path artifact hop ----

/**
 * C5 GUARD — the hop from the MCP dispatcher onto the chat turn. The artifact mappers and
 * the dispatcher are pinned elsewhere (`core/runtime/chat-artifacts.test.ts`,
 * `core/mcp/artifact-tools.test.ts`); this is the join between them, and it is the exact
 * place the truncation used to be lost: `agent-loop.ts` flattened the whole tool result
 * into a markdown string, so whether the user learned the result was clipped depended on
 * whether the model chose to mention it.
 */
test('C5 GUARD: the chat path carries truncated/rowLimit/message off a tool result', () => {
  const artifacts = artifactsFromToolResult({
    structuredContent: {
      artifacts: [
        {
          kind: 'table',
          columns: ['region'],
          rows: [['DE']],
          rowCount: 1000,
          source: 'ad-hoc-sql',
          truncated: true,
          rowLimit: 1000,
          message: 'Result clipped at QUERY_MAX_ROWS=1000. These are the first 1000 rows, not a sample.',
        },
      ],
    },
  });
  assert.equal(artifacts.length, 1);
  const t = artifacts[0];
  assert.ok(t.kind === 'table');
  if (t.kind !== 'table') return;
  assert.equal(t.truncated, true, 'the chat path dropped `truncated`');
  assert.equal(t.rowLimit, 1000, 'the chat path dropped `rowLimit`');
  assert.match(t.message ?? '', /not a sample/, 'the chat path dropped the tool’s own sentence');
  assert.equal(t.rowCount, 1000, 'the chat path must keep the TOOL-reported row count');
});

test('C5 GUARD: a tool DENIAL yields no artifacts — an error is never rendered as data', () => {
  assert.deepEqual(
    artifactsFromToolResult({
      isError: true,
      structuredContent: { error: { code: 'forbidden', reason: 'needs builder', hint: 'ask a builder' } },
    }),
    [],
  );
  // And a tool that returned no structured payload at all contributes nothing.
  assert.deepEqual(artifactsFromToolResult({}), []);
});

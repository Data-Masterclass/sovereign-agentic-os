/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The Home chat runs on the STRONG role; clearly defined sub-tasks go to the WORKER role
 * USER STORY: As the owner I want the assistant's orchestration, planning, tool choice and final
 *             answer on the strong model, and only bounded, schema-checked sub-tasks on the cheap
 *             one, with every step of a turn showing which role and model handled it, and what it cost.
 * ARCHITECTURE: the REAL `runOsAssistant`, harness, confirm gate and delegation helpers. Only the
 *             model (scripted) and the governed dispatch are stand-ins. Every test has a negative twin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import type { RpcDispatch } from '@core/runtime/agent-loop';
import { runOsAssistant } from '@core/runtime/agent-loop';
import { BudgetExceededError } from '@core/infra/litellm-credential';
import { __resetConfirmations } from '@core/policy/confirmations';
import { completeWithEscalation, isSpendLimit } from '@core/runtime/escalate';

const STRONG = 'sovereign-strong';
const WORKER = 'sovereign-worker';
const user: CurrentUser = { id: 'u-roles', name: 'Robin', domains: ['sales'], role: 'creator' };

const wiring = { escalate: completeWithEscalation, isSpendLimit };
beforeEach(() => { __resetConfirmations(); });

/** A tool result of `chars` characters, shaped like a big table dump. */
const bigResult = (chars: number) => JSON.stringify({ rows: Array.from({ length: Math.ceil(chars / 40) }, (_, i) => ({ id: i, total: `EUR ${1000 + i}` })) }).slice(0, chars);
const dispatchOf = (text: string): RpcDispatch => async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });

type Seen = { model: string; purpose?: string; hasTools: boolean };
type Delegation = Record<string, unknown> | null;
const SUMMARY_PRESET = { preset: 'summarise_tool_result', input_refs: ['last'] };
/**
 * The scripted model. Plan (no tools) -> act: `whoami` -> act: the delegation STRONG chooses to make (or none) -> final.
 * A request whose purpose names a delegation is the WORKER's: it gets `workerReply`.
 */
function scripted(seen: Seen[], delegation: Delegation = null, workerReply: (req: LlmRequest) => string | Error | { toolCalls: LlmCall extends never ? never : { id: string; name: string; args: Record<string, unknown> }[] } = () => '{}'): LlmCall {
  let phase = 0;
  return async (req) => {
    const purpose = req.purpose;
    seen.push({ model: req.model, purpose, hasTools: !!req.tools });
    if (purpose?.startsWith('delegate:')) {
      const r = workerReply(req);
      if (r instanceof Error) throw r;
      if (typeof r === 'object') return { content: '{}', toolCalls: r.toolCalls, usage: { input: 1000, output: 100, total: 1100 } };
      return { content: r, toolCalls: [], usage: { input: 1000, output: 100, total: 1100 } };
    }
    if (!req.tools) return { content: '1. look up who I am', toolCalls: [], usage: { input: 5000, output: 200, total: 5200 } };
    phase += 1;
    if (phase === 1) return { content: '', toolCalls: [{ id: 'c1', name: 'whoami', args: {} }], usage: { input: 5200, output: 50, total: 5250 } };
    if (phase === 2 && delegation) return { content: '', toolCalls: [{ id: 'c2', name: 'delegate_to_worker', args: delegation }], usage: { input: 5300, output: 60, total: 5360 } };
    return { content: 'You are Robin.', toolCalls: [], usage: { input: 6000, output: 80, total: 6080 } };
  };
}
const turn = (llm: LlmCall, dispatch: RpcDispatch, extra: Record<string, unknown> = {}) =>
  runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'who am I?' }], llm, dispatch, ...extra } as Parameters<typeof runOsAssistant>[0]);
const delegated = (seen: Seen[]) => seen.filter((s) => s.purpose?.startsWith('delegate:'));

const GOOD_SUMMARY = JSON.stringify({ result: { summary: 'A table of rows; totals run from EUR 1000 upward.', key_figures: ['EUR 1000'] }, confidence: 0.9 });
const TABLE_SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };

// ---------------------------------------------------------------- 3. strong decides to delegate

test('DELEGATION: strong calls delegate_to_worker; the worker answers the sub-task; strong still answers', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, SUMMARY_PRESET, () => GOOD_SUMMARY), dispatchOf(bigResult(30_000)));
  assert.deepEqual(delegated(seen).map((s) => [s.model, s.purpose]), [[WORKER, 'delegate:summarise_tool_result']]);
  assert.equal(seen.at(-1)?.model, STRONG, 'the final answer is strong');
  assert.equal(res.finalText, 'You are Robin.');
  const d = res.modelTrace.delegations[0];
  assert.equal(d.role, 'worker');
  assert.equal(d.model, WORKER);
  assert.match(d.instruction, /Condense the input/);
  assert.deepEqual(d.schemaKeys, ['summary', 'key_figures']);
  assert.match(d.resultPreview, /EUR 1000/);
  const step = res.steps.find((x) => x.tool === 'delegate_to_worker');
  assert.ok(step && !step.isError && /"delegated":true/.test(step.result));
});

test('DELEGATION twin: the OS never delegates by itself: a huge tool result with no delegation call makes no worker call', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, null), dispatchOf(bigResult(300_000)));
  assert.equal(delegated(seen).length, 0);
  assert.equal(res.modelTrace.delegations.length, 0);
});

test('SCHEMA REQUIRED: a custom delegation without an output_schema is refused and the worker is never called', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, { instruction: 'tag it', input_refs: ['last'] }, () => GOOD_SUMMARY), dispatchOf('{"ok":true}'));
  assert.equal(delegated(seen).length, 0);
  const step = res.steps.find((x) => x.tool === 'delegate_to_worker');
  assert.ok(step?.isError && /output_schema_required/.test(step.result));
});

test('SCHEMA REQUIRED twin: the same delegation WITH a schema runs on the worker', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen, { instruction: 'tag it', input_refs: ['last'], output_schema: TABLE_SCHEMA }, () => JSON.stringify({ result: { label: 'ok' }, confidence: 0.9 })), dispatchOf('{"ok":true}'));
  assert.deepEqual(delegated(seen).map((s) => s.model), [WORKER]);
});

test('SCHEMA REQUIRED: a schema that is not a JSON schema of type object is refused', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, { instruction: 'x', input_refs: ['last'], output_schema: { type: 'string' } }), dispatchOf('{}'));
  assert.equal(delegated(seen).length, 0);
  assert.ok(res.steps.find((x) => x.tool === 'delegate_to_worker')?.isError);
});

// ---------------------------------------------------------------- 4. the worker is read-only

test('READ-ONLY: a worker that asks for a write tool gets nothing executed; the dispatch never sees it', async () => {
  const reached: string[] = [];
  const dispatch: RpcDispatch = async (_u, req) => { reached.push(String((req.params as { name?: string }).name)); return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }; };
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, SUMMARY_PRESET, () => ({ toolCalls: [{ id: 'w1', name: 'delete_dataset', args: { id: 'x' } }] })), dispatch);
  assert.deepEqual(reached, ['whoami'], 'only the tool strong chose ran; the worker\'s call did not');
  assert.deepEqual(delegated(seen).map((s) => s.model), [WORKER, STRONG], 'the empty worker answer failed its check and went to strong, which also failed');
  assert.ok(res.steps.find((x) => x.tool === 'delegate_to_worker')?.isError);
});

test('READ-ONLY twin: the request the worker gets carries NO tools', async () => {
  const offered: boolean[] = [];
  const base = scripted([], SUMMARY_PRESET);
  const llm: LlmCall = async (req) => {
    if (req.purpose?.startsWith('delegate:')) { offered.push(!!req.tools); return { content: GOOD_SUMMARY, toolCalls: [] }; }
    return base(req);
  };
  await turn(llm, dispatchOf(bigResult(30_000)));
  assert.deepEqual(offered, [false]);
});

test('READ-ONLY: the worker sees only the results strong referenced; an unknown reference is refused', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, { preset: 'summarise_tool_result', input_refs: ['step:9'] }), dispatchOf('{}'));
  assert.equal(delegated(seen).length, 0);
  assert.match(res.steps.find((x) => x.tool === 'delegate_to_worker')?.result ?? '', /invalid_input_ref/);
});

// ---------------------------------------------------------------- 5. validation and escalation

test('ESCALATION: a worker answer that fails the schema is redone on STRONG, and the trace says so', async () => {
  const seen: Seen[] = [];
  let n = 0;
  const res = await turn(scripted(seen, SUMMARY_PRESET, () => (n++ === 0 ? 'not json at all' : GOOD_SUMMARY)), dispatchOf(bigResult(30_000)));
  assert.deepEqual(delegated(seen).map((s) => s.model), [WORKER, STRONG]);
  assert.deepEqual(res.modelTrace.calls.filter((c) => c.delegation === 1).map((c) => [c.role, c.escalated]), [['worker', false], ['strong', true]]);
  assert.equal(res.modelTrace.delegations[0].escalated, true);
  assert.equal(res.modelTrace.delegations[0].role, 'strong');
});

test('ESCALATION: an invented figure (valid schema, not in the source) and a low confidence both escalate', async () => {
  for (const bad of [
    JSON.stringify({ result: { summary: 'ok', key_figures: ['EUR 999999999'] }, confidence: 0.9 }),
    JSON.stringify({ result: { summary: 'ok', key_figures: ['EUR 1000'] }, confidence: 0.2 }),
  ]) {
    const seen: Seen[] = [];
    let n = 0;
    await turn(scripted(seen, SUMMARY_PRESET, () => (n++ === 0 ? bad : GOOD_SUMMARY)), dispatchOf(bigResult(30_000)));
    assert.deepEqual(delegated(seen).map((s) => s.model), [WORKER, STRONG]);
  }
});

test('ESCALATION twin: a valid worker answer is final: no strong call for the sub-task, no escalation flag', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, SUMMARY_PRESET, () => GOOD_SUMMARY), dispatchOf(bigResult(30_000)));
  assert.deepEqual(delegated(seen).map((s) => s.model), [WORKER]);
  assert.ok(res.modelTrace.calls.every((c) => !c.escalated));
});

// ---------------------------------------------------------------- 6. depth 1

test('DEPTH: a delegation made from a worker context (depth 2) is refused', async () => {
  const { runDelegateTool, newTurnDelegations } = await import('@core/runtime/delegate');
  const llm: LlmCall = async () => ({ content: GOOD_SUMMARY, toolCalls: [] });
  const deps = { llm, ...wiring, results: () => [{ tool: 't', text: 'EUR 1000 '.repeat(2000) }], turn: newTurnDelegations() };
  const refused = await runDelegateTool(SUMMARY_PRESET, { ...deps, depth: 1 });
  assert.ok(refused.isError && /delegation_depth/.test(refused.text));
  assert.equal(deps.turn.count, 0);
});

test('DEPTH twin: from strong (depth 0) the same delegation runs; the primitive refuses depth 1 as well', async () => {
  const { runDelegateTool, newTurnDelegations, delegateToWorker } = await import('@core/runtime/delegate');
  const llm: LlmCall = async () => ({ content: GOOD_SUMMARY, toolCalls: [] });
  const ok = await runDelegateTool(SUMMARY_PRESET, { llm, ...wiring, results: () => [{ tool: 't', text: 'EUR 1000 '.repeat(2000) }], turn: newTurnDelegations() });
  assert.ok(!ok.isError, ok.text);
  await assert.rejects(() => delegateToWorker({ task: 'x', input: 'a', inputSchema: (r) => r as string, serialize: (i) => i, instruction: 'i', outputSchema: (r) => r, budget: { maxInputChars: 10, maxOutputTokens: 10 }, caller: llm, ...wiring, depth: 1 }), /depth/i);
});

// ---------------------------------------------------------------- 7. never worker for deciding

test('NEVER WORKER: plan, tool choice (every call that offers tools) and the final answer are strong, even on a turn that delegated', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen, SUMMARY_PRESET, () => GOOD_SUMMARY), dispatchOf(bigResult(30_000)));
  const deciding = seen.filter((s) => !s.purpose?.startsWith('delegate:'));
  assert.ok(deciding.length >= 4);
  assert.ok(deciding.every((s) => s.model === STRONG));
  assert.ok(seen.filter((s) => s.hasTools).every((s) => s.model === STRONG));
});

test('NEVER WORKER twin: the worker call is the ONLY kind of call on the worker model', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen, SUMMARY_PRESET, () => GOOD_SUMMARY), dispatchOf(bigResult(30_000)));
  assert.ok(seen.filter((s) => s.model === WORKER).every((s) => s.purpose?.startsWith('delegate:') && !s.hasTools));
});

// ---------------------------------------------------------------- 8. trace: role, model, cost

test('TRACE: every call lists purpose, role and model; each role and each delegation has a cost from the catalog prices', async () => {
  const { priceTrace } = await import('@core/runtime/turn-ledger');
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, SUMMARY_PRESET, () => GOOD_SUMMARY), dispatchOf(bigResult(30_000)));
  assert.deepEqual(res.modelTrace.calls.map((c) => c.purpose), ['plan', 'act', 'act', 'delegate:summarise_tool_result', 'act']);
  assert.deepEqual(res.modelTrace.calls.map((c) => c.role), ['strong', 'strong', 'strong', 'worker', 'strong']);
  const priced = priceTrace(res.modelTrace, { [STRONG]: { inputPerM: 1.5, outputPerM: 1.75 }, [WORKER]: { inputPerM: 0.15, outputPerM: 0.25 } });
  const sIn = 5000 + 5200 + 5300 + 6000, sOut = 200 + 50 + 60 + 80;
  assert.ok(Math.abs(priced.byRole.strong.cost! - (sIn * 1.5 + sOut * 1.75) / 1e6) < 1e-12);
  assert.ok(Math.abs(priced.byRole.worker.cost! - (1000 * 0.15 + 100 * 0.25) / 1e6) < 1e-12);
  assert.ok(Math.abs(priced.delegations[0].cost! - (1000 * 0.15 + 100 * 0.25) / 1e6) < 1e-12);
  assert.equal(priced.byRole.strong.calls, 4);
  assert.equal(priced.byRole.worker.calls, 1);
});

test('TRACE twin: a model with no catalog price books NO cost (never a made-up zero)', async () => {
  const { priceTrace } = await import('@core/runtime/turn-ledger');
  const res = await turn(scripted([]), dispatchOf('{"ok":true}'));
  const priced = priceTrace(res.modelTrace, {});
  assert.equal(priced.byRole.strong.cost, undefined);
  assert.equal(priced.byRole.strong.calls, 3);
});

// ---------------------------------------------------------------- 7. budgets still bind

test('BUDGET: a budget rejection on the strong call ends the turn with the typed error; it is not retried on the worker', async () => {
  const seen: Seen[] = [];
  const llm: LlmCall = async (req) => { seen.push({ model: req.model, hasTools: !!req.tools }); throw new BudgetExceededError('Budget has been exceeded'); };
  await assert.rejects(() => turn(llm, dispatchOf('{}')), BudgetExceededError);
  assert.deepEqual(seen.map((s) => s.model), [STRONG], 'one strong call, no fallback to the cheap model');
});

test('BUDGET: the per-turn step cap still binds the strong turn (maxIterations)', async () => {
  const seen: Seen[] = [];
  let i = 0;
  const llm: LlmCall = async (req) => {
    seen.push({ model: req.model, hasTools: !!req.tools });
    if (!req.tools) return { content: '1. loop', toolCalls: [] };
    return { content: '', toolCalls: [{ id: `c${i}`, name: 'whoami', args: { n: i++ } }] };
  };
  const res = await turn(llm, dispatchOf('{"ok":true}'), { maxIterations: 3 });
  assert.equal(res.iterations, 3);
  assert.ok(seen.every((s) => s.model === STRONG));
});

test('BUDGET twin: a worker-side budget rejection ends the turn: it is NOT escalated to the pricier model', async () => {
  const seenModels: string[] = [];
  const base = scripted([], SUMMARY_PRESET);
  const llm: LlmCall = async (req) => {
    if (req.purpose?.startsWith('delegate:') && !req.escalated) throw new BudgetExceededError('Budget has been exceeded');
    seenModels.push(`${req.model}:${req.purpose}`);
    return base(req);
  };
  await assert.rejects(() => turn(llm, dispatchOf(bigResult(30_000))), BudgetExceededError);
  assert.ok(!seenModels.some((m) => m.includes('delegate:')), 'the sub-task was never retried on strong');
});

test('BUDGET: a turn may make at most MAX_DELEGATIONS_PER_TURN delegations; the next one is refused with a typed result', async () => {
  const { runDelegateTool, newTurnDelegations, MAX_DELEGATIONS_PER_TURN } = await import('@core/runtime/delegate');
  const llm: LlmCall = async () => ({ content: GOOD_SUMMARY, toolCalls: [] });
  const deps = { llm, ...wiring, results: () => [{ tool: 't', text: 'EUR 1000 '.repeat(2000) }], turn: newTurnDelegations() };
  for (let i = 0; i < MAX_DELEGATIONS_PER_TURN; i++) assert.ok(!(await runDelegateTool(SUMMARY_PRESET, deps)).isError);
  const over = await runDelegateTool(SUMMARY_PRESET, deps);
  assert.ok(over.isError && /turn_budget/.test(over.text));
});

test('BUDGET twin: a delegation answer is capped at max_tokens (the worker request carries the clamp)', async () => {
  const { runDelegateTool, newTurnDelegations, MAX_WORKER_OUTPUT_TOKENS } = await import('@core/runtime/delegate');
  const caps: (number | undefined)[] = [];
  const llm: LlmCall = async (req) => { caps.push(req.maxTokens); return { content: GOOD_SUMMARY, toolCalls: [] }; };
  const deps = { llm, ...wiring, results: () => [{ tool: 't', text: 'EUR 1000 '.repeat(2000) }], turn: newTurnDelegations() };
  await runDelegateTool({ ...SUMMARY_PRESET, max_tokens: 10_000_000 }, deps);
  await runDelegateTool({ ...SUMMARY_PRESET, max_tokens: 300 }, deps);
  assert.deepEqual(caps, [MAX_WORKER_OUTPUT_TOKENS, 300]);
});

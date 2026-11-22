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
import { _reset as resetModels, setAssistantModel, assistantModelInfo } from '@tabs/admin/lib/models';
import { _reset as resetSettings } from '@tabs/admin/lib/settings';

const STRONG = 'sovereign-strong';
const WORKER = 'sovereign-worker';
const user: CurrentUser = { id: 'u-roles', name: 'Robin', domains: ['sales'], role: 'creator' };

beforeEach(() => { resetModels(); resetSettings(); __resetConfirmations(); });

/** A tool result of `chars` characters, shaped like a big table dump. */
const bigResult = (chars: number) => JSON.stringify({ rows: Array.from({ length: Math.ceil(chars / 40) }, (_, i) => ({ id: i, total: `EUR ${1000 + i}` })) }).slice(0, chars);
const dispatchOf = (text: string): RpcDispatch => async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });

type Seen = { model: string; purpose?: string; hasTools: boolean };
/**
 * The scripted model. Plan → no tools; act → one `whoami` call, then the final answer. A request whose
 * purpose names a worker task gets `workerReply`; everything else is the harness's.
 */
function scripted(seen: Seen[], workerReply: (req: LlmRequest) => string | Error = () => '{}'): LlmCall {
  let acted = false;
  return async (req) => {
    seen.push({ model: req.model, purpose: (req as { purpose?: string }).purpose, hasTools: !!req.tools });
    if ((req as { purpose?: string }).purpose?.startsWith('delegate:')) {
      const r = workerReply(req);
      if (r instanceof Error) throw r;
      return { content: r, toolCalls: [], usage: { input: 1000, output: 100, total: 1100 } };
    }
    if (!req.tools) return { content: '1. look up who I am', toolCalls: [], usage: { input: 5000, output: 200, total: 5200 } };
    if (!acted) { acted = true; return { content: '', toolCalls: [{ id: 'c1', name: 'whoami', args: {} }], usage: { input: 5200, output: 50, total: 5250 } }; }
    return { content: 'You are Robin.', toolCalls: [], usage: { input: 6000, output: 80, total: 6080 } };
  };
}
const turn = (llm: LlmCall, dispatch: RpcDispatch, extra: Record<string, unknown> = {}) =>
  runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'who am I?' }], llm, dispatch, ...extra } as Parameters<typeof runOsAssistant>[0]);

// ---------------------------------------------------------------- 1. strong by default / 2. the pin

test('DEFAULT: the assistant plans, acts and answers on the STRONG role', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen), dispatchOf('{"ok":true}'));
  assert.ok(seen.length >= 3, 'plan, act, final');
  assert.deepEqual([...new Set(seen.map((s) => s.model))], [STRONG]);
  assert.equal(assistantModelInfo().model, STRONG);
  assert.equal(assistantModelInfo().role, 'strong');
  assert.equal(assistantModelInfo().explicit, false);
});

test('DEFAULT twin: the assistant is NOT on the worker by default (the old default would fail this)', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen), dispatchOf('{"ok":true}'));
  assert.equal(seen.filter((s) => s.model === WORKER).length, 0);
});

test('PIN: an explicit admin pin overrides the strong default for plan and act', async () => {
  setAssistantModel('acme-chat');
  const seen: Seen[] = [];
  await turn(scripted(seen), dispatchOf('{"ok":true}'));
  assert.deepEqual([...new Set(seen.map((s) => s.model))], ['acme-chat']);
  assert.deepEqual({ ...assistantModelInfo() }, { model: 'acme-chat', role: 'pinned', explicit: true });
});

test('PIN twin: without a pin the assistant is on strong, not on a leftover pin', async () => {
  setAssistantModel('acme-chat');
  resetModels();
  const seen: Seen[] = [];
  await turn(scripted(seen), dispatchOf('{"ok":true}'));
  assert.ok(!seen.some((s) => s.model === 'acme-chat'));
  assert.ok(seen.every((s) => s.model === STRONG));
});

// ---------------------------------------------------------------- 3. defined sub-task → worker

const GOOD_CONDENSE = JSON.stringify({ summary: 'A table of 500 rows; totals run from EUR 1000 upward.', keyFigures: ['EUR 1000'] });

test('SUB-TASK: a long tool result is condensed on the WORKER, and the answer is still strong', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, () => GOOD_CONDENSE), dispatchOf(bigResult(30_000)));
  const delegated = seen.filter((s) => s.purpose?.startsWith('delegate:'));
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0].model, WORKER);
  assert.equal(delegated[0].purpose, 'delegate:condense');
  assert.equal(seen.at(-1)?.model, STRONG, 'the final answer is strong');
  assert.equal(res.finalText, 'You are Robin.');
  assert.ok(res.modelTrace.calls.some((c) => c.role === 'worker' && c.purpose === 'delegate:condense' && c.escalated === false));
});

test('SUB-TASK twin: a short tool result is NOT delegated at all', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, () => GOOD_CONDENSE), dispatchOf('{"ok":true}'));
  assert.equal(seen.filter((s) => s.purpose?.startsWith('delegate:')).length, 0);
  assert.equal(res.modelTrace.calls.filter((c) => c.role === 'worker').length, 0);
});

// ---------------------------------------------------------------- 4. failed validation → escalate

test('ESCALATION: a worker answer that fails its schema is redone on STRONG, and the turn trace says so', async () => {
  const seen: Seen[] = [];
  let n = 0;
  const reply = () => (n++ === 0 ? 'not json at all' : GOOD_CONDENSE);
  const res = await turn(scripted(seen, reply), dispatchOf(bigResult(30_000)));
  const delegated = seen.filter((s) => s.purpose?.startsWith('delegate:'));
  assert.deepEqual(delegated.map((s) => s.model), [WORKER, STRONG], 'worker first, then ONE escalation to strong');
  const esc = res.modelTrace.calls.filter((c) => c.purpose?.startsWith('delegate:'));
  assert.deepEqual(esc.map((c) => [c.role, c.escalated]), [['worker', false], ['strong', true]]);
});

test('ESCALATION also fires when the worker invents a figure that is not in the source (schema is valid)', async () => {
  const seen: Seen[] = [];
  let n = 0;
  const invented = JSON.stringify({ summary: 'ok', keyFigures: ['EUR 999999999'] });
  await turn(scripted(seen, () => (n++ === 0 ? invented : GOOD_CONDENSE)), dispatchOf(bigResult(30_000)));
  assert.deepEqual(seen.filter((s) => s.purpose?.startsWith('delegate:')).map((s) => s.model), [WORKER, STRONG]);
});

test('ESCALATION twin: a valid worker answer is final: no strong call for the sub-task, no escalation flag', async () => {
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, () => GOOD_CONDENSE), dispatchOf(bigResult(30_000)));
  assert.deepEqual(seen.filter((s) => s.purpose?.startsWith('delegate:')).map((s) => s.model), [WORKER]);
  assert.ok(res.modelTrace.calls.every((c) => !c.escalated));
});

// ---------------------------------------------------------------- 5. never worker for deciding

test('NEVER WORKER: plan, tool choice (the act call that carries the tools) and the final answer are never on the worker, even on a turn that delegated', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen, () => GOOD_CONDENSE), dispatchOf(bigResult(30_000)));
  const deciding = seen.filter((s) => !s.purpose?.startsWith('delegate:'));
  assert.ok(deciding.length >= 3);
  assert.ok(deciding.every((s) => s.model === STRONG));
  assert.ok(seen.filter((s) => s.hasTools).every((s) => s.model === STRONG), 'every call that offers tools is strong');
});

test('NEVER WORKER twin: the delegation door refuses a task that decides, plans or chooses tools, and a task with no schema', async () => {
  const { delegate, WORKER_TASKS } = await import('@core/runtime/delegate');
  const llm: LlmCall = async () => ({ content: '{}', toolCalls: [] });
  for (const bad of ['plan', 'choose_tool', 'decide', 'answer', 'write']) {
    await assert.rejects(() => delegate(llm, { task: bad as never, input: 'x' }), /not a delegable task/i, bad);
  }
  assert.deepEqual([...WORKER_TASKS].sort(), ['classify', 'condense', 'draft_save_as', 'extract', 'format_table']);
  for (const t of WORKER_TASKS) assert.ok(typeof (await import('@core/runtime/delegate')).schemaOf(t) === 'function', `${t} has a schema check`);
});

// ---------------------------------------------------------------- 6. trace: role, model, cost per role

test('TRACE: every model call of the turn is listed with its role, model and purpose; cost per role comes from the catalog prices', async () => {
  const { priceTrace } = await import('@core/runtime/turn-ledger');
  const seen: Seen[] = [];
  const res = await turn(scripted(seen, () => GOOD_CONDENSE), dispatchOf(bigResult(30_000)));
  const calls = res.modelTrace.calls;
  assert.deepEqual(calls.map((c) => c.purpose), ['plan', 'act', 'delegate:condense', 'act']);
  assert.deepEqual(calls.map((c) => c.role), ['strong', 'strong', 'worker', 'strong']);
  assert.ok(calls.every((c) => c.model === (c.role === 'strong' ? STRONG : WORKER)));
  // catalog prices (EUR per 1M tokens): strong 1.50 in / 1.75 out, worker 0.15 in / 0.25 out
  const priced = priceTrace(res.modelTrace, { [STRONG]: { inputPerM: 1.5, outputPerM: 1.75 }, [WORKER]: { inputPerM: 0.15, outputPerM: 0.25 } });
  const strongIn = 5000 + 5200 + 6000, strongOut = 200 + 50 + 80;
  assert.ok(Math.abs(priced.byRole.strong.cost! - (strongIn * 1.5 + strongOut * 1.75) / 1e6) < 1e-12);
  assert.ok(Math.abs(priced.byRole.worker.cost! - (1000 * 0.15 + 100 * 0.25) / 1e6) < 1e-12);
  assert.equal(priced.byRole.strong.calls, 3);
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

test('BUDGET twin: a worker-side budget rejection during a sub-task also ends the turn (escalating would hit the same key)', async () => {
  const llm: LlmCall = async (req) => {
    if ((req as { purpose?: string }).purpose === 'delegate:condense') throw new BudgetExceededError('Budget has been exceeded');
    return scripted([])(req);
  };
  await assert.rejects(() => turn(llm, dispatchOf(bigResult(30_000))), BudgetExceededError);
});

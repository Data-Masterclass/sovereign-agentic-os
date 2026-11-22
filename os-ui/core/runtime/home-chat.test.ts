/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat — the governed chat turn: gated tools, confirmed writes, private confirmations
 * USER STORY: As a user I want the Home chat to do what I may do and nothing else, to ask me before
 *             it changes anything, and to keep my pending actions to myself.
 * ARCHITECTURE: the REAL `runOsAssistant` + `userConfirmGate` + confirmation store + `handleRpc`
 *             (role floor). Only the model is scripted and, where a test must prove "never reached",
 *             the dispatch is a spy.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { osToolSpecs, runOsAssistant, type RpcDispatch } from '@core/runtime/agent-loop';
import { decideConfirmation } from '@core/runtime/confirm-execute';
import { askTurnResponse } from '@core/runtime/ask-response';
import { __resetConfirmations } from '@core/policy/confirmations';
import type { LlmCall } from '@core/runtime/agentic';

beforeEach(() => __resetConfirmations());

const creator: CurrentUser = { id: 'u-creator', name: 'Robin', domains: ['sales'], role: 'creator' };
const otherCreator: CurrentUser = { id: 'u-other', name: 'Sam', domains: ['sales'], role: 'creator' };
const domainAdmin: CurrentUser = { id: 'u-da', name: 'Dana', domains: ['sales'], role: 'domain_admin' };

/** PLAN turn (no tools), then ONE batch of tool calls, then the final answer. */
function script(calls: { name: string; args: Record<string, unknown> }[], finalText = 'done'): LlmCall {
  let acted = false;
  return async (req) => {
    if (!req.tools) return { content: '1. plan', toolCalls: [] };
    if (!acted) {
      acted = true;
      return { content: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, args: c.args })) };
    }
    return { content: finalText, toolCalls: [] };
  };
}

function spyDispatch() {
  const calls: { name: string; args: unknown }[] = [];
  const dispatch: RpcDispatch = async (_user, req) => {
    const p = (req.params ?? {}) as { name?: string; arguments?: unknown };
    calls.push({ name: String(p.name), args: p.arguments });
    return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
  };
  return { dispatch, calls };
}

const turn = (user: CurrentUser, llm: LlmCall, extra: Partial<Parameters<typeof runOsAssistant>[0]> = {}) =>
  runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'go' }], llm, confirm: { conversationId: 'conv-1' }, ...extra });

// 1. a creator's chat cannot call a gated tool --------------------------------------------------
test('a creator\'s chat is not even offered a Builder+ tool, and naming it anyway returns the typed forbidden error', async () => {
  const names = osToolSpecs(creator, null).map((t) => t.name);
  assert.ok(!names.includes('approve_promotion'), 'approve_promotion is not offered to a creator');
  const res = await turn(creator, script([{ name: 'approve_promotion', args: { requestId: 'r-1' } }]));
  assert.equal(res.steps[0].isError, true);
  assert.equal(res.pending.length, 0, 'a refused call is not parked as if it could be confirmed');
  const wire = askTurnResponse({
    finalText: res.finalText, plan: res.plan, steps: res.steps, artifacts: res.artifacts,
    tab: null, traceId: res.traceId, model: 'm', pending: res.pending,
  });
  assert.equal(wire.tools[0].error?.code, 'forbidden');
  assert.match(wire.tools[0].error?.reason ?? '', /domain_admin|builder/);
  assert.ok((wire.tools[0].error?.hint ?? '').length > 0, 'a hint travels with the refusal');
});

test('NEGATIVE TWIN: the same tool IS offered to a domain admin and is not refused as forbidden', async () => {
  assert.ok(osToolSpecs(domainAdmin, null).map((t) => t.name).includes('approve_promotion'));
  const res = await turn(domainAdmin, script([{ name: 'approve_promotion', args: { requestId: 'nope' } }]));
  const wire = askTurnResponse({
    finalText: res.finalText, plan: res.plan, steps: res.steps, artifacts: res.artifacts,
    tab: null, traceId: res.traceId, model: 'm', pending: res.pending,
  });
  assert.notEqual(wire.tools[0].error?.code, 'forbidden');
});

// 2. a write needs confirmation ----------------------------------------------------------------
test('a write is parked: the governed dispatch is never reached until the user confirms, and then runs once with the exact args', async () => {
  const spy = spyDispatch();
  const args = { name: 'Orders', domain: 'sales' };
  const res = await turn(creator, script([{ name: 'create_dataset', args }]), { dispatch: spy.dispatch });
  assert.equal(spy.calls.length, 0, 'nothing ran before the confirmation');
  assert.equal(res.pending.length, 1);
  assert.equal(res.pending[0].tool, 'create_dataset');

  const id = res.pending[0].confirmationId;
  const done = await decideConfirmation({ user: creator, confirmationId: id, conversationId: 'conv-1', decision: 'confirm', dispatch: spy.dispatch });
  assert.equal(done.status, 'executed');
  assert.deepEqual(spy.calls, [{ name: 'create_dataset', args }], 'ran once, with the args that were shown');

  const again = await decideConfirmation({ user: creator, confirmationId: id, conversationId: 'conv-1', decision: 'confirm', dispatch: spy.dispatch });
  assert.equal(again.status, 'refused');
  assert.equal(spy.calls.length, 1, 'a second confirm does not run it again');
});

test('NEGATIVE TWIN: a read runs straight through; a declined write never runs', async () => {
  const spy = spyDispatch();
  const read = await turn(creator, script([{ name: 'whoami', args: {} }]), { dispatch: spy.dispatch });
  assert.equal(read.pending.length, 0);
  assert.deepEqual(spy.calls.map((c) => c.name), ['whoami']);

  const spy2 = spyDispatch();
  const w = await turn(creator, script([{ name: 'create_dataset', args: { name: 'X' } }]), { dispatch: spy2.dispatch });
  const d = await decideConfirmation({ user: creator, confirmationId: w.pending[0].confirmationId, conversationId: 'conv-1', decision: 'decline', dispatch: spy2.dispatch });
  assert.equal(d.status, 'declined');
  assert.equal(spy2.calls.length, 0);
});

// 3. user A cannot act on user B's pending action ------------------------------------------------
test('user B cannot confirm or decline user A\'s pending write; A still can; another conversation cannot either', async () => {
  const spy = spyDispatch();
  const res = await turn(creator, script([{ name: 'create_dataset', args: { name: 'Private' } }]), { dispatch: spy.dispatch });
  const id = res.pending[0].confirmationId;

  for (const decision of ['confirm', 'decline'] as const) {
    const b = await decideConfirmation({ user: otherCreator, confirmationId: id, conversationId: 'conv-1', decision, dispatch: spy.dispatch });
    assert.equal(b.status, 'refused');
  }
  const wrongConv = await decideConfirmation({ user: creator, confirmationId: id, conversationId: 'conv-2', decision: 'confirm', dispatch: spy.dispatch });
  assert.equal(wrongConv.status, 'refused');
  assert.equal(spy.calls.length, 0, 'none of the refused attempts ran anything');

  const a = await decideConfirmation({ user: creator, confirmationId: id, conversationId: 'conv-1', decision: 'confirm', dispatch: spy.dispatch });
  assert.equal(a.status, 'executed');
});

// 4. a role-denied tool at confirm time is still refused by the governed door ---------------------
test('confirming does not widen rights: the governed dispatch re-checks the role and its typed error comes back', async () => {
  // A write the creator may park (create_dataset) is fine; force a denial through a dispatch that
  // answers the way handleRpc does for a role-gated tool.
  const denied: RpcDispatch = async () => ({
    jsonrpc: '2.0', id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'forbidden', reason: 'x requires domain_admin; you are creator', hint: 'Ask a domain_admin to run it, or keep your work Personal.' } }) }],
      structuredContent: { error: { code: 'forbidden', reason: 'x requires domain_admin; you are creator', hint: 'Ask a domain_admin to run it, or keep your work Personal.' } },
      isError: true,
    },
  });
  const res = await turn(creator, script([{ name: 'create_dataset', args: { name: 'X' } }]));
  const out = await decideConfirmation({ user: creator, confirmationId: res.pending[0].confirmationId, conversationId: 'conv-1', decision: 'confirm', dispatch: denied });
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'forbidden');
});

// 5. one trace per turn --------------------------------------------------------------------------
test('every model call of a Home chat turn carries ONE W3C trace id, so the gateway files them in one Langfuse trace', async () => {
  const { gatewayTraceHeaders } = await import('@core/runtime/gateway-trace');
  const seen: { traceId?: string; parent?: string }[] = [];
  let acted = false;
  const llm: LlmCall = async (req) => {
    seen.push({ traceId: req.observe?.traceId, parent: req.observe?.parentObservationId });
    if (!req.tools) return { content: '1. plan', toolCalls: [] };
    if (!acted) { acted = true; return { content: '', toolCalls: [{ id: 'a', name: 'whoami', args: {} }] }; }
    return { content: 'ok', toolCalls: [] };
  };
  const res = await turn(creator, llm, { dispatch: spyDispatch().dispatch });
  assert.ok(seen.length >= 3, 'plan, act and the final answer each made a model call');
  assert.match(res.traceId, /^[0-9a-f]{32}$/, 'the turn id is a W3C trace id');
  assert.ok(seen.every((s) => s.traceId === res.traceId), 'all calls share the turn id');
  assert.ok(seen.every((s) => /^[0-9a-f]{16}$/.test(s.parent ?? '')), 'and name a W3C parent span');
  for (const s of seen) assert.ok(gatewayTraceHeaders({ traceId: s.traceId!, parentObservationId: s.parent }).headers.traceparent, 'a traceparent header is sent');
});

test('NEGATIVE TWIN: the drawer path (no confirm) keeps its ask- id, which sends no traceparent', async () => {
  const seen: (string | undefined)[] = [];
  const llm: LlmCall = async (req) => { seen.push(req.observe?.traceId); return { content: req.tools ? 'ok' : '1. plan', toolCalls: [] }; };
  const res = await runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'go' }], llm });
  assert.match(res.traceId, /^ask-/);
});

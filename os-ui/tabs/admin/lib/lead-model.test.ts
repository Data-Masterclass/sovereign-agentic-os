/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The OS-wide lead-model switch (settings `standardFirstEscalation`): strong leads by default, worker leads as a cost saver
 * USER STORY: As a platform admin I choose whether the strong model leads (default) or the worker leads and strong
 *             only steps in to escalate, and I see which model leads right now.
 * ARCHITECTURE: the real settings store, `roles.ts`, `runOsAssistant` and harness; the model is scripted. Each test has a negative twin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall, LlmRequest } from '@core/runtime/agentic';
import type { RpcDispatch } from '@core/runtime/agent-loop';
import { runOsAssistant } from '@core/runtime/agent-loop';
import { __resetConfirmations } from '@core/policy/confirmations';
import { _reset as resetSettings, __setForTests as setSettings, updateSettings } from '@tabs/admin/lib/settings';
import { _reset as resetModels, assistantModelInfo } from '@tabs/admin/lib/models';
import { standardFirstEscalationEnabled, leadMode, leadModel } from '@core/models/roles';
import { LEAD_SWITCH_LABEL, leadSwitchText } from '@tabs/admin/lib/lead-model-label';

const STRONG = 'sovereign-strong';
const WORKER = 'sovereign-worker';
const user: CurrentUser = { id: 'u-lead', name: 'Robin', domains: ['sales'], role: 'creator' };
beforeEach(() => { resetSettings(); resetModels(); __resetConfirmations(); });

const ok: RpcDispatch = async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
type Seen = { model: string; tools: string[] };
/** `script(model, n)` answers the n-th non-plan call made on that model; plan = the call without tools. */
function llmOf(seen: Seen[], answer: (req: LlmRequest, n: number) => { content: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; refusal?: string }): LlmCall {
  let n = 0;
  return async (req) => {
    seen.push({ model: req.model, tools: (req.tools ?? []).map((t) => t.function.name) });
    if (!req.tools) return { content: '1. do it', toolCalls: [] };
    const a = answer(req, ++n);
    return { content: a.content, toolCalls: a.toolCalls ?? [], ...(a.refusal ? { refusal: a.refusal } : {}) };
  };
}
const turn = (llm: LlmCall, dispatch: RpcDispatch = ok) => runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'who am I?' }], llm, dispatch });
const FINAL = (): { content: string } => ({ content: 'You are Robin.' });

// ------------------------------------------------------------------ the default and the switch

test('UNSET means OFF: strong leads (a fresh install, or a settings blob that never had the switch)', () => {
  assert.equal(standardFirstEscalationEnabled(), false);
  assert.equal(leadMode(), 'strong');
  assert.deepEqual({ ...leadModel() }, { mode: 'strong', lead: STRONG, escalation: WORKER });
  assert.deepEqual({ ...assistantModelInfo() }, { model: STRONG, role: 'strong', explicit: false });
});

test('UNSET twin: an explicit stored ON is kept (not reset to the new default), and so is an explicit OFF', () => {
  setSettings({ standardFirstEscalation: true });
  assert.equal(standardFirstEscalationEnabled(), true);
  assert.equal(leadMode(), 'worker');
  assert.deepEqual({ ...assistantModelInfo() }, { model: WORKER, role: 'worker', explicit: false });
  setSettings({ standardFirstEscalation: false });
  assert.equal(leadMode(), 'strong');
});

test('an unrelated settings save does not turn the switch on (nil-safe merge keeps it unset)', () => {
  updateSettings({ currency: 'GBP' });
  assert.equal(standardFirstEscalationEnabled(), false);
});

// ------------------------------------------------------------------ OFF: strong leads, delegates by its own choice

test('OFF: plan and act run on STRONG, and strong is offered delegate_to_worker but not escalate_to_strong', async () => {
  const seen: Seen[] = [];
  await turn(llmOf(seen, FINAL));
  assert.ok(seen.every((s) => s.model === STRONG));
  const withTools = seen.filter((s) => s.tools.length);
  assert.ok(withTools.every((s) => s.tools.includes('delegate_to_worker') && !s.tools.includes('escalate_to_strong')));
});

test('OFF twin: a call to escalate_to_strong is not a tool here: refused, nothing changes, strong stays the lead', async () => {
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, (_r, n) => (n === 1 ? { content: '', toolCalls: [{ id: 'e', name: 'escalate_to_strong', args: { reason: 'x' } }] } : FINAL())));
  assert.ok(seen.every((s) => s.model === STRONG));
  assert.equal(res.modelTrace.escalations.length, 0);
});

// ------------------------------------------------------------------ ON: worker leads, strong escalates

test('ON: plan and act run on the WORKER; the worker is offered escalate_to_strong and NOT delegate_to_worker', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, FINAL));
  assert.ok(seen.every((s) => s.model === WORKER), 'no strong call on a turn that needed none');
  assert.ok(seen.filter((s) => s.tools.length).every((s) => s.tools.includes('escalate_to_strong') && !s.tools.includes('delegate_to_worker')));
  assert.equal(res.modelTrace.escalations.length, 0);
  assert.ok(res.modelTrace.calls.every((c) => c.role === 'worker'));
});

test('ON: the worker calls escalate_to_strong for a task it judges too hard; the rest of the turn runs on STRONG and the trace shows the escalation', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, (r) => (r.model === WORKER ? { content: '', toolCalls: [{ id: 'e', name: 'escalate_to_strong', args: { reason: 'needs a multi-step plan' } }] } : FINAL())));
  assert.deepEqual(seen.map((s) => s.model), [WORKER, WORKER, STRONG]);
  assert.equal(res.finalText, 'You are Robin.');
  assert.deepEqual(res.modelTrace.escalations.map((e) => [e.from, e.to, e.tool, e.reason]), [[WORKER, STRONG, 'escalate_to_strong', 'needs a multi-step plan']]);
  assert.deepEqual(res.modelTrace.calls.map((c) => c.role), ['worker', 'worker', 'strong']);
});

test('ON twin: escalation happens ONCE; on strong, escalate_to_strong is answered "already on strong" and changes nothing', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, (_r, n) => (n <= 2 ? { content: '', toolCalls: [{ id: `e${n}`, name: 'escalate_to_strong', args: { reason: 'hard' } }] } : FINAL())));
  assert.equal(res.modelTrace.escalations.length, 1);
  assert.match(res.steps[1].result, /already on the strong model/i);
});

test('ON: an EMPTY answer from the worker escalates to strong, which answers', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, (r) => (r.model === WORKER ? { content: '   ' } : FINAL())));
  assert.deepEqual(seen.map((s) => s.model), [WORKER, WORKER, STRONG]);
  assert.equal(res.finalText, 'You are Robin.');
  assert.equal(res.modelTrace.escalations[0].reason, 'empty answer');
});

test('ON: a REFUSAL from the worker escalates to strong', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, (r) => (r.model === WORKER ? { content: '', refusal: 'I cannot help with that' } : FINAL())));
  assert.equal(seen.at(-1)?.model, STRONG);
  assert.equal(res.modelTrace.escalations[0].reason, 'refusal');
});

test('ON twin: a normal worker answer is NOT escalated', async () => {
  setSettings({ standardFirstEscalation: true });
  const seen: Seen[] = [];
  const res = await turn(llmOf(seen, FINAL));
  assert.equal(res.modelTrace.escalations.length, 0);
  assert.ok(!seen.some((s) => s.model === STRONG));
});

test('OFF twin: an empty answer from the (strong) lead is not escalated to the worker', async () => {
  const seen: Seen[] = [];
  await turn(llmOf(seen, () => ({ content: '' })));
  assert.ok(seen.every((s) => s.model === STRONG));
});

test('ON: a tool that keeps failing (validation failure) escalates to strong; one failure does not', async () => {
  setSettings({ standardFirstEscalation: true });
  const bad: RpcDispatch = async () => ({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'invalid argument' }] } });
  const run = async (calls: number) => {
    const seen: Seen[] = [];
    let i = 0;
    const res = await turn(llmOf(seen, (r) => (r.model === WORKER && i++ < calls ? { content: '', toolCalls: [{ id: `w${i}`, name: 'whoami', args: { n: i } }] } : FINAL())), bad);
    return res.modelTrace.escalations.length;
  };
  assert.equal(await run(2), 1);
  assert.equal(await run(1), 0);
});

test('ON: the pin still wins: an admin-pinned assistant is the lead whatever the switch says', async () => {
  setSettings({ standardFirstEscalation: true });
  const { setAssistantModel } = await import('@tabs/admin/lib/models');
  setAssistantModel('acme-chat');
  const seen: Seen[] = [];
  await turn(llmOf(seen, FINAL));
  assert.ok(seen.every((s) => s.model === 'acme-chat'));
});

// ------------------------------------------------------------------ the label

test('UI: the switch is labelled as a cost saver and names the worker as the lead', () => {
  assert.match(LEAD_SWITCH_LABEL, /Save costs/);
  assert.match(LEAD_SWITCH_LABEL, /worker model leads/i);
  assert.match(LEAD_SWITCH_LABEL, /lower quality and fewer capabilities/i);
  assert.match(leadSwitchText(true, WORKER), /worker/);
});

test('UI twin: the OFF text says strong leads and does not claim a saving; the lead model is shown', () => {
  const off = leadSwitchText(false, STRONG);
  assert.match(off, /strong/);
  assert.doesNotMatch(off, /Save costs/);
  assert.match(off, new RegExp(STRONG));
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Save as" — an answer becomes a KPI, dashboard, knowledge note or agent, behind a confirm card
 * USER STORY: As a user I want to keep a good answer as a real artifact, with one click, and still be
 *             asked before anything is created.
 * ARCHITECTURE: a fixed kind → existing create tool table; the turn is the normal Home chat turn
 *             restricted to that ONE tool, behind the same user-confirm gate.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { SAVE_AS, saveAsPlan } from '@core/runtime/save-as';
import { runOsAssistant, type RpcDispatch } from '@core/runtime/agent-loop';
import { __resetConfirmations } from '@core/policy/confirmations';
import type { LlmCall } from '@core/runtime/agentic';

beforeEach(() => __resetConfirmations());
const creator: CurrentUser = { id: 'u-c', name: 'Robin', domains: ['sales'], role: 'creator' };

test('each kind maps to its one existing create tool; knowledge is save_knowledge_note and never author_knowledge', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SAVE_AS).map(([k, v]) => [k, v.tool])), {
    kpi: 'define_metric',
    dashboard: 'create_dashboard',
    knowledge: 'save_knowledge_note',
    agent: 'create_agent_system',
  });
  assert.ok(!JSON.stringify(SAVE_AS).includes('author_knowledge'));
});

test('a kind whose tool this user is not offered (or this build does not have) is unavailable, not guessed', () => {
  assert.equal(saveAsPlan('dashboard', ['create_dashboard', 'whoami']).ok, true);
  const none = saveAsPlan('knowledge', ['author_knowledge', 'create_dashboard']);
  assert.equal(none.ok, false, 'author_knowledge is NOT a stand-in for save_knowledge_note');
  assert.equal(saveAsPlan('nonsense' as 'kpi', ['define_metric']).ok, false);
});

function script(calls: { name: string; args: Record<string, unknown> }[]): LlmCall {
  let acted = false;
  return async (req) => {
    if (!req.tools) return { content: '1. plan', toolCalls: [] };
    if (!acted) { acted = true; return { content: '', toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, args: c.args })) }; }
    return { content: 'done', toolCalls: [] };
  };
}
function spy() {
  const calls: string[] = [];
  const dispatch: RpcDispatch = async (_u, req) => { calls.push(String((req.params as { name?: string }).name)); return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }; };
  return { dispatch, calls };
}

test('a save-as turn offers ONLY its tool, parks that call behind the confirm card, and runs nothing else', async () => {
  const s = spy();
  const res = await runOsAssistant({
    user: creator, tab: null, messages: [{ role: 'user', content: 'save' }], confirm: { conversationId: 'conv-12345678' },
    onlyTools: ['create_dashboard'], dispatch: s.dispatch,
    llm: script([{ name: 'create_dashboard', args: { name: 'Sales' } }]),
  });
  assert.equal(res.pending.length, 1);
  assert.equal(res.pending[0].tool, 'create_dashboard');
  assert.deepEqual(s.calls, [], 'nothing ran before the confirmation');
});

test('NEGATIVE TWIN: any other tool the model names is refused — even a write this role may use — and never reaches the dispatch', async () => {
  const s = spy();
  const res = await runOsAssistant({
    user: creator, tab: null, messages: [{ role: 'user', content: 'save' }], confirm: { conversationId: 'conv-12345678' },
    onlyTools: ['create_dashboard'], dispatch: s.dispatch,
    llm: script([{ name: 'create_dataset', args: { name: 'X' } }, { name: 'whoami', args: {} }]),
  });
  assert.equal(res.pending.length, 0, 'not parked');
  assert.deepEqual(s.calls, [], 'not executed: the surface closed it before the dispatch');
  assert.ok(res.steps.every((st) => st.isError), 'both are refused');
});

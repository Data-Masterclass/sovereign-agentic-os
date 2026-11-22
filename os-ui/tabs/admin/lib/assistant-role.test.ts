/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The assistant model: the STRONG role by default, an admin pin overrides it
 * USER STORY: As a platform admin I see the assistant run on the strong role until I pin another alias.
 * ARCHITECTURE: the real `runOsAssistant` with a scripted model and a stub dispatch; the pin is the
 *             real `tabs/admin/lib/models` store. Each test has a negative twin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import type { RpcDispatch } from '@core/runtime/agent-loop';
import { runOsAssistant } from '@core/runtime/agent-loop';
import { __resetConfirmations } from '@core/policy/confirmations';
import { _reset as resetModels, setAssistantModel, assistantModelInfo } from '@tabs/admin/lib/models';
import { _reset as resetSettings } from '@tabs/admin/lib/settings';

const STRONG = 'sovereign-strong';
const WORKER = 'sovereign-worker';
const user: CurrentUser = { id: 'u-roles', name: 'Robin', domains: ['sales'], role: 'creator' };
beforeEach(() => { resetModels(); resetSettings(); __resetConfirmations(); });

const dispatch: RpcDispatch = async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
type Seen = { model: string };
function scripted(seen: Seen[]): LlmCall {
  let phase = 0;
  return async (req) => {
    seen.push({ model: req.model });
    if (!req.tools) return { content: '1. look up who I am', toolCalls: [] };
    phase += 1;
    return phase === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'whoami', args: {} }] } : { content: 'You are Robin.', toolCalls: [] };
  };
}
const turn = (llm: LlmCall) => runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'who am I?' }], llm, dispatch });

// ---------------------------------------------------------------- 1. strong by default / 2. the pin

test('DEFAULT: the assistant plans, acts and answers on the STRONG role', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen));
  assert.ok(seen.length >= 3, 'plan, act, final');
  assert.deepEqual([...new Set(seen.map((s) => s.model))], [STRONG]);
  assert.equal(assistantModelInfo().model, STRONG);
  assert.equal(assistantModelInfo().role, 'strong');
  assert.equal(assistantModelInfo().explicit, false);
});

test('DEFAULT twin: the assistant is NOT on the worker by default (the old default would fail this)', async () => {
  const seen: Seen[] = [];
  await turn(scripted(seen));
  assert.equal(seen.filter((s) => s.model === WORKER).length, 0);
});

test('PIN: an explicit admin pin overrides the strong default for plan and act', async () => {
  setAssistantModel('acme-chat');
  const seen: Seen[] = [];
  await turn(scripted(seen));
  assert.deepEqual([...new Set(seen.map((s) => s.model))], ['acme-chat']);
  assert.deepEqual({ ...assistantModelInfo() }, { model: 'acme-chat', role: 'pinned', explicit: true });
});

test('PIN twin: without a pin the assistant is on strong, not on a leftover pin', async () => {
  setAssistantModel('acme-chat');
  resetModels();
  const seen: Seen[] = [];
  await turn(scripted(seen));
  assert.ok(!seen.some((s) => s.model === 'acme-chat'));
  assert.ok(seen.every((s) => s.model === STRONG));
});



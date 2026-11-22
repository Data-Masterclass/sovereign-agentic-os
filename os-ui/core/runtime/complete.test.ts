/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, setAssistantModel } from '@tabs/admin/lib/models';
import { assistantComplete, resolveAssistantModelId, AssistantNotConfiguredError, type AssistantCaller } from '@core/runtime/complete';

beforeEach(() => _reset());

test('resolveAssistantModelId returns the configured assistant (sovereign chat by default)', () => {
  assert.equal(resolveAssistantModelId(), 'sovereign-default');
});

test('assistantComplete runs on the chosen model via the injected caller', async () => {
  setAssistantModel('stackit-managed');
  let seenModel = '';
  let seenUser = '';
  const caller: AssistantCaller = async (req) => { seenModel = req.model; seenUser = req.user ?? ''; return 'hi'; };
  const out = await assistantComplete([{ role: 'user', content: 'hello' }], { user: { id: 'sara' }, caller });
  assert.equal(out.model, 'stackit-managed');
  assert.equal(out.content, 'hi');
  assert.equal(seenModel, 'stackit-managed'); // routed to the ONE assistant model
  assert.equal(seenUser, 'sara'); // caller identity threaded for audit
});

test('a pin at a model LiteLLM no longer has is NOT hidden: the call goes to the gateway and its refusal reaches the caller (no silent fall-back to Standard)', async () => {
  // The OS keeps no model list, so it cannot tell locally that an alias is gone: LiteLLM's own
  // "model not found" answers the call. The pin is never silently replaced by another model.
  setAssistantModel('ghost-model');
  let seenModel = '';
  await assert.rejects(
    assistantComplete([{ role: 'user', content: 'x' }], { caller: async (req) => { seenModel = req.model; throw new Error('LiteLLM: model not found: ghost-model'); } }),
    /model not found: ghost-model/,
  );
  assert.equal(seenModel, 'ghost-model', 'the call asked for the pinned model, not for Standard');
});

test('an unresolvable assistant is still an HONEST, admin-actionable error', () => {
  assert.equal(typeof AssistantNotConfiguredError, 'function');
  assert.equal(new AssistantNotConfiguredError().status, 503);
});

test('assistantComplete threads the surface (`tab`) to the caller so the spend is tagged with it; default is unset → `assistant`', async () => {
  const seen: (string | undefined)[] = [];
  const caller: AssistantCaller = async (req) => { seen.push(req.tab); return 'ok'; };
  await assistantComplete([{ role: 'user', content: 'x' }], { model: 'sovereign-default', user: { id: 'amir', domains: ['sales'] }, tab: 'files', caller });
  await assistantComplete([{ role: 'user', content: 'x' }], { model: 'sovereign-default', user: { id: 'amir', domains: ['sales'] }, caller });
  assert.deepEqual(seen, ['files', undefined]);
});

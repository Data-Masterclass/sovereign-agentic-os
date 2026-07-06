/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _reset, registerAssistantModel, setAssistantModel } from '../platform-admin/models.ts';
import { assistantComplete, resolveAssistantModelId, AssistantNotConfiguredError, type AssistantCaller } from './complete.ts';

beforeEach(() => _reset());

test('resolveAssistantModelId returns the configured assistant (sovereign chat by default)', () => {
  assert.equal(resolveAssistantModelId(), 'ministral-8b');
});

test('assistantComplete runs on the chosen model via the injected caller', async () => {
  registerAssistantModel({ id: 'stackit-managed', label: 'STACKIT', endpoint: { baseUrl: 'https://x/v1', modelName: 'chat', keyRef: { name: 'n', key: 'k' }, fingerprint: 'sha256:1' }, addedBy: 'sara' });
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

test('assistantComplete throws an HONEST error when no assistant is configured', async () => {
  // Defensive: point the assistant at a model that is not in the catalog.
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.platform.models')] as { assistant: string };
  pinned.assistant = 'ghost-model';
  assert.throws(() => resolveAssistantModelId(), (e: unknown) => e instanceof AssistantNotConfiguredError);
  await assert.rejects(
    assistantComplete([{ role: 'user', content: 'x' }], { caller: async () => 'never' }),
    (e: unknown) => e instanceof AssistantNotConfiguredError && (e as { status?: number }).status === 503,
  );
});

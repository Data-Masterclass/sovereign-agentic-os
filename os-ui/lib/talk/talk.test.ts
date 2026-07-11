/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, setDocs } from '../data/store.ts';
import { estimateTokens } from '../infra/context/context-assembler.ts';
import { inputBudget } from '../models/context-windows.ts';
import { roleModel } from '../models/roles.ts';
import type { CurrentUser } from '../core/auth.ts';
import { talkTo, type TalkLlm } from './talk.ts';

/**
 * The talkTo orchestrator: it returns the answer + the model's reasoning SEPARATELY, cites
 * real entitled ids, and NEVER assembles a context that exceeds the reasoning model's input
 * budget. We drive it on the `metrics` tab (metadata-only grounding — hermetic, no Trino)
 * with an INJECTED llm, so the whole turn runs offline.
 */
const amir: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };

// A fake reasoner: echoes back what it was given so we can assert on the assembled input,
// and returns a DISTINCT answer + reasoning_content so we can prove they stay apart.
function spyLlm(): { llm: TalkLlm; seen: { messages: { role: string; content: string }[] }[] } {
  const seen: { messages: { role: string; content: string }[] }[] = [];
  const llm: TalkLlm = async (messages) => {
    seen.push({ messages });
    return { content: 'ANSWER: you have metrics defined.', reasoning: 'THINKING: first I checked the scope.' };
  };
  return { llm, seen };
}

beforeEach(() => {
  __resetStore();
  // `trace` (governed audit) does a best-effort fetch — make it fail INSTANTLY offline so
  // the turn doesn't wait on a network timeout. talkTo swallows the audit error by design.
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error('offline');
  };
});

test('talkTo returns answer and reasoning SEPARATELY (never merged)', async () => {
  const ds = createDataset(amir, { name: 'Orders' });
  buildVersion(ds.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/o.dlt.yml' });

  const { llm } = spyLlm();
  const res = await talkTo('metrics', 'what metrics do I have?', amir, [], { llm });

  assert.equal(res.ok, true);
  assert.match(res.answer, /ANSWER:/);
  assert.match(res.reasoning, /THINKING:/);
  // The reasoning is NEVER concatenated into the answer.
  assert.doesNotMatch(res.answer, /THINKING:/);
  assert.doesNotMatch(res.reasoning, /ANSWER:/);
});

test('talkTo cites only entitled ids (from the DLS-scoped overview)', async () => {
  const ds = createDataset(amir, { name: 'Orders' });
  buildVersion(ds.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/o.dlt.yml' });
  setDocs(ds.id, amir, { description: 'orders', columns: [{ name: 'total', description: 'order total' }] });

  const { llm } = spyLlm();
  // On the DATA tab the overview lists the caller's datasets → they become citations.
  const res = await talkTo('data', 'summarize my data', amir, [], { llm });
  assert.ok(res.citations.length >= 1, 'the entitled dataset is cited');
  assert.ok(res.citations.every((c) => typeof c.id === 'string' && c.id.length > 0));
});

test('talkTo NEVER exceeds the reasoning model input budget', async () => {
  // Seed many datasets so the pinned overview is large — the assembler must still bound it.
  for (let i = 0; i < 60; i++) {
    const ds = createDataset(amir, { name: `Dataset ${i}` });
    buildVersion(ds.id, amir, 'bronze', { quality: 'passing', artifact: 'b.yml' });
  }
  const { llm, seen } = spyLlm();
  await talkTo('data', 'anything', amir, [], { llm });

  const budget = inputBudget(roleModel('reasoning'));
  assert.equal(seen.length, 1);
  const assembledTokens = seen[0].messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.ok(assembledTokens <= budget, `assembled ${assembledTokens} must be ≤ budget ${budget}`);
});

test('talkTo degrades honestly when the model is unreachable (no fabricated answer)', async () => {
  const failing: TalkLlm = async () => {
    throw new Error('gateway down');
  };
  const res = await talkTo('metrics', 'q', amir, [], { llm: failing });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'model_failed');
  assert.match(res.answer, /unreachable/i);
  assert.equal(res.reasoning, '');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, setDocs } from '../data/store.ts';
import { estimateTokens } from '../infra/context/context-assembler.ts';
import { inputBudget } from '../models/context-windows.ts';
import { roleModel } from '../models/roles.ts';
import { config } from '../core/config.ts';
import type { CurrentUser } from '../core/auth.ts';
import { talkTo, isWeakAnswer, type TalkLlm } from './talk.ts';

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

// -------------------------------------------------------- cost-tier / escalation --

// A spy that records the MODEL each call used and returns a scripted answer per call,
// so we can assert exactly which tier answered and how many calls were made.
function tierSpy(answers: string[]): { llm: TalkLlm; models: string[] } {
  const models: string[] = [];
  let i = 0;
  const llm: TalkLlm = async (_messages, model) => {
    models.push(model);
    const content = answers[Math.min(i, answers.length - 1)] ?? '';
    i += 1;
    return { content, reasoning: '' };
  };
  return { llm, models };
}

test('isWeakAnswer flags empty / too-short / hedged answers, passes real ones', () => {
  assert.equal(isWeakAnswer(''), true);
  assert.equal(isWeakAnswer('   '), true);
  assert.equal(isWeakAnswer('n/a'), true); // shorter than the min-answer floor
  assert.equal(isWeakAnswer("I don't know based on your scope."), true);
  assert.equal(isWeakAnswer('There is not enough information to answer.'), true);
  assert.equal(
    isWeakAnswer('You have 3 datasets: Orders, Customers and Returns, all in the sales domain.'),
    false,
  );
});

test('talkTo runs on the STANDARD tier first and STAYS cheap on a good answer', async () => {
  const good = 'You have 2 personal metrics defined over the Orders dataset.';
  const { llm, models } = tierSpy([good]);
  const res = await talkTo('metrics', 'what metrics do I have?', amir, [], { llm });

  assert.equal(res.ok, true);
  assert.equal(res.answer, good);
  // Exactly ONE call, on the configured copilot tier (standard by default) — NO escalation.
  assert.equal(models.length, 1);
  assert.equal(models[0], roleModel(config.talkCopilotTier));
  assert.notEqual(models[0], roleModel('reasoning'), 'default copilot tier is not reasoning');
});

test('talkTo ESCALATES to reasoning once when the standard answer is weak', async () => {
  const strong = 'You have 2 personal metrics: revenue and order_count, both over Orders.';
  // First (standard) answer is hedged → weak; the escalation answer is strong.
  const { llm, models } = tierSpy(["I'm not sure — I don't have enough information.", strong]);
  const res = await talkTo('metrics', 'what metrics do I have?', amir, [], { llm });

  assert.equal(res.ok, true);
  assert.equal(res.answer, strong, 'the escalated (reasoning) answer is returned');
  assert.equal(models.length, 2, 'exactly one retry');
  assert.equal(models[0], roleModel(config.talkCopilotTier));
  assert.equal(models[1], roleModel('reasoning'), 'the retry is on the reasoning tier');
});

test('talkTo does NOT escalate when escalation is disabled (config-driven)', async () => {
  const weak = "I'm not sure.";
  const { llm, models } = tierSpy([weak, 'stronger answer that should never be used']);
  const original = config.talkEscalateToReasoning;
  // config is `as const` (compile-time only) — mutable at runtime for this toggle test.
  (config as { talkEscalateToReasoning: boolean }).talkEscalateToReasoning = false;
  try {
    const res = await talkTo('metrics', 'q', amir, [], { llm });
    assert.equal(res.ok, true);
    assert.equal(models.length, 1, 'no retry when escalation is off');
    assert.equal(res.answer, weak, 'the weak-but-real primary answer stands');
  } finally {
    (config as { talkEscalateToReasoning: boolean }).talkEscalateToReasoning = original;
  }
});

test('talkTo keeps the primary answer if the escalation retry itself fails', async () => {
  const weak = 'n/a';
  let i = 0;
  const llm: TalkLlm = async () => {
    i += 1;
    if (i === 1) return { content: weak, reasoning: '' };
    throw new Error('reasoning tier down');
  };
  const res = await talkTo('metrics', 'q', amir, [], { llm });
  assert.equal(res.ok, true, 'an escalation hiccup must not lose the real answer');
  assert.equal(res.answer, weak);
});

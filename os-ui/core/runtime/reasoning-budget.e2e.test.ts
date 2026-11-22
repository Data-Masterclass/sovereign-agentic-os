/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reasoning-model replies and model limits, proven on the REAL LiteLLM gateway.
 * USER STORY: As a user of a reasoning model I get my answer (or the exact reason there is none) and the OS
 *             sizes its calls from the limits of the model the role is mapped to — shown on the gateway
 *             the chart ships, not on a fake.
 * ARCHITECTURE:
 *   - Runs ONLY against tests/reasoning-budget/litellm-config.yaml on the chart's LiteLLM image
 *     (scripts/tests/reasoning-budget/run.sh). Without it the suite SKIPS; with REASONING_E2E=1 a missing
 *     gateway is a failure. The provider behind the gateway is a STUB served by this test process: it
 *     answers with `reasoning_content`, `content: ""` and `finish_reason: "length"` while `max_tokens`
 *     is under 1000 (what a thinking model does on a tight budget). Lyceum is never called.
 *   - The OS side is production code: `ensureModelLimitsFresh` (the real `/model/info` +
 *     `/router/settings` reads), `modelContext`, `liteLlmCaller`.
 *   - NEGATIVE TWINS: the limits must differ from the built-in defaults (a faked or skipped read cannot
 *     pass); an always-thinking model must end in the precise failure after exactly one retry; the
 *     explicit override still beats the catalog.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const E2E = process.env.REASONING_E2E === '1';
const GW = (process.env.REASONING_E2E_URL ?? 'http://127.0.0.1:14210').replace(/\/+$/, '');
const STUB_PORT = Number(process.env.REASONING_STUB_PORT ?? '18940');
const skip = E2E ? false : 'run scripts/tests/reasoning-budget/run.sh (needs the real LiteLLM image)';
process.env.LITELLM_URL = GW;
process.env.LITELLM_MASTER_KEY = 'sk-test-scoped-agent-key'; // = the scoped key test-setup.mjs sends (DB-less gateway: one key)

type Seen = { model: string; max_tokens?: number; reasoning_effort?: unknown };
const seen: Seen[] = [];
let stub: Server | null = null;
if (E2E) {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw || '{}') as { model?: string; max_tokens?: number; reasoning_effort?: unknown; messages?: { content?: string }[] };
      seen.push({ model: String(b.model), max_tokens: b.max_tokens, reasoning_effort: b.reasoning_effort });
      const always = JSON.stringify(b.messages ?? []).includes('ALWAYS_THINK');
      // RUNAWAY: thinks until the cap unless told to think less (what Kimi does on Lyceum); otherwise only a tight cap exhausts it.
      const runaway = JSON.stringify(b.messages ?? []).includes('RUNAWAY') && b.reasoning_effort !== 'low';
      const exhausted = always || runaway || ((b.max_tokens ?? 0) < 1000 && b.reasoning_effort !== 'low');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion', created: 1, model: b.model,
        choices: [{ index: 0, finish_reason: exhausted ? 'length' : 'stop', message: { role: 'assistant', content: exhausted ? '' : 'The long report.', reasoning_content: 'Let me think about the report in detail. '.repeat(30) } }],
        usage: { prompt_tokens: 20, completion_tokens: exhausted ? (b.max_tokens ?? 4000) : 1500, total_tokens: 1520, completion_tokens_details: { reasoning_tokens: exhausted ? (b.max_tokens ?? 4000) : 900 } },
      }));
    });
  });
  await new Promise<void>((r) => stub!.listen(STUB_PORT, '0.0.0.0', () => r()));
}
after(() => { stub?.close(); });

const { ensureModelLimitsFresh } = await import('@core/models/model-limits-live');
const { modelContext, outputCeiling } = await import('@core/models/context-windows');
const { liteLlmCaller } = await import('@core/runtime/runtime');
const { ReasoningBudgetExhaustedError } = await import('@core/runtime/reasoning-budget');

const ask = (content: string, extra: Record<string, unknown> = {}) =>
  liteLlmCaller()({ model: 'sovereign-strong', messages: [{ role: 'user', content }], maxTokens: 300, ...extra });

test('the limits come from the gateway: sovereign-strong resolves to the catalog model it is mapped to', { skip }, async () => {
  await ensureModelLimitsFresh();
  const strong = modelContext('sovereign-strong', {});
  assert.equal(strong.contextWindow, 256000, 'the strong role follows kimi-stub (256000), not the built-in 200000');
  assert.equal(strong.maxOutput, 32768);
  assert.equal(strong.reservedOutput, 32000);
  const worker = modelContext('sovereign-worker', {});
  assert.equal(worker.contextWindow, 131000);
  assert.equal(worker.reservedOutput, 8192, 'never above what the model can produce');
  assert.equal(outputCeiling('sovereign-strong', {}), 32768);
});

test('NEGATIVE TWIN: the explicit override still beats what the gateway says', { skip }, async () => {
  await ensureModelLimitsFresh();
  assert.equal(modelContext('sovereign-strong', { 'sovereign-strong': { contextWindow: 64000, reservedOutput: 3000 } }).contextWindow, 64000);
});

test('a tight max_tokens on a reasoning model: the gateway returns length + empty content + reasoning, and the OS retries once larger and gets the answer', { skip }, async () => {
  await ensureModelLimitsFresh();
  seen.length = 0;
  const out = await ask('write the long report');
  assert.equal(out.content, 'The long report.');
  assert.deepEqual(seen.map((s) => s.max_tokens), [300, 1200], 'one call at the tight budget, one retry at four times');
  assert.equal(out.usage?.reasoning, 900);
  assert.equal(seen[1].reasoning_effort, 'low');
});

test('a RUNAWAY (uses its whole normal budget thinking) is cured by lower effort at the SAME cap, not by a bigger cap', { skip }, async () => {
  await ensureModelLimitsFresh();
  seen.length = 0;
  const out = await ask('RUNAWAY write the report', { maxTokens: 32000, reasoningEffort: 'medium' });
  assert.equal(out.content, 'The long report.');
  assert.deepEqual(seen.map((s) => [s.max_tokens, s.reasoning_effort]), [[32000, 'medium'], [32000, 'low']]);
  assert.equal(out.retry?.reasoningEffort, 'low');
});

test('NEGATIVE TWIN: a model that thinks forever ends in the precise failure after exactly one retry, naming the role and the catalog model', { skip }, async () => {
  await ensureModelLimitsFresh();
  seen.length = 0;
  await assert.rejects(ask('ALWAYS_THINK about this'), (e: unknown) => {
    assert.ok(e instanceof ReasoningBudgetExhaustedError);
    assert.match((e as Error).message, /the model spent its whole output budget on reasoning \(1200 tokens\); raise the output limit for sovereign-strong\/kimi-stub/);
    return true;
  });
  assert.equal(seen.length, 2);
});

test('reasoning_effort: LiteLLM 1.109 forwards it to the OpenAI-compatible provider when sent, and sends nothing when it is not', { skip }, async () => {
  seen.length = 0;
  await ask('write the long report', { maxTokens: 2000, reasoningEffort: 'low' });
  assert.equal(seen[0].reasoning_effort, 'low');
  seen.length = 0;
  await ask('write the long report', { maxTokens: 2000 });
  assert.equal(seen[0].reasoning_effort, undefined);
});

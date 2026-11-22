/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A model call's trace records HOW it ended (finish_reason, reasoning tokens, the cap, the effort)
 *             even when masking has reduced its content to nothing.
 * USER STORY: As an operator diagnosing "the model returned nothing" I read `finish_reason: length` and the
 *             reasoning tokens off the trace, with masking on and the output redacted.
 * ARCHITECTURE: the REAL `NodeSDK` + `LangfuseSpanProcessor` (in-memory exporter), the REAL `observe.span().llm()`.
 *             Numbers and enums are metadata, not content, so masking's content level leaves them.
 *             NEGATIVE TWIN: a normal answer records `content_empty: false`, no retry marker.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

mock.module('@core/infra/os-mirror', { namedExports: { osMirror: () => ({ read: async () => ({ state: 'found', doc: { settings: { langfuseMasking: { enabled: true, level: 'content' } } } }), getDoc: async () => null, writeThrough: () => undefined, __reset: () => undefined }) } });
const { __useSpanExporterForTests, flushLangfuse, withRunTrace } = await import('@core/infra/langfuse');
const { __resetMaskingForTests } = await import('@core/infra/masking-policy');
const { ReasoningBudgetExhaustedError } = await import('@core/runtime/reasoning-budget');
const exporter = new InMemorySpanExporter();
__useSpanExporterForTests(exporter);
beforeEach(() => { __resetMaskingForTests(); exporter.reset(); });

async function oneCall(llm: () => Promise<unknown>, runId: string) {
  await withRunTrace({ runId, systemId: 's', systemName: 's', userId: 'u', domain: 'd', task: 'secret task text' }, async (observe) => {
    const span = observe.span('agent2');
    try { await span.llm(llm as never, 'llm.act_agent2')({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'secret prompt' }], maxTokens: 16000, reasoningEffort: 'medium' }); } catch { /* the failure is what is recorded */ }
    span.end({});
    observe.finish({ reachedEnd: false, parked: false, interrupted: false, failed: true, path: [], finalChars: 0, stepsUsed: 1 });
  });
  await flushLangfuse();
  const span = exporter.getFinishedSpans().find((s) => s.name === 'llm.act_agent2');
  assert.ok(span, 'the model-call span is exported');
  return span.attributes as Record<string, unknown>;
}
const meta = (a: Record<string, unknown>, k: string) => a[`langfuse.observation.metadata.${k}`];

test('a reply that spent its budget on reasoning: finish_reason and reasoning tokens are on the span, the content is not', async () => {
  const a = await oneCall(async () => ({ content: '', toolCalls: [], finishReason: 'length', reasoning: { chars: 9000 }, usage: { input: 24000, output: 16000, total: 40000, reasoning: 16000 } }), 'run_md-0000-4000-8000-000000000001');
  assert.equal(meta(a, 'finish_reason'), 'length');
  assert.equal(meta(a, 'reasoning_tokens'), '16000');
  assert.equal(meta(a, 'completion_tokens'), '16000');
  assert.equal(meta(a, 'max_tokens'), '16000');
  assert.equal(meta(a, 'reasoning_effort'), 'medium');
  assert.equal(meta(a, 'content_empty'), 'true');
  assert.ok(!JSON.stringify(a).includes('secret prompt'), 'masking still holds the content back');
});

test('the retry that cured it is recorded: lower effort, the first reasoning tokens', async () => {
  const a = await oneCall(async () => ({ content: 'the report', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 5000, total: 5001, reasoning: 4000 }, retry: { reason: 'reasoning_exhausted', maxTokens: 16000, reasoningEffort: 'low', firstReasoningTokens: 16000 } }), 'run_md-0000-4000-8000-000000000002');
  assert.equal(meta(a, 'reasoning_retry'), 'true');
  assert.equal(meta(a, 'retry_reasoning_effort'), 'low');
  assert.equal(meta(a, 'first_reasoning_tokens'), '16000');
});

test('a call that FAILED with the precise reasoning error still records finish_reason and the tokens', async () => {
  const a = await oneCall(async () => { throw new ReasoningBudgetExhaustedError(16000, 'sovereign-strong', 'kimi', 16000); }, 'run_md-0000-4000-8000-000000000003');
  assert.equal(meta(a, 'finish_reason'), 'length');
  assert.equal(meta(a, 'reasoning_budget_exhausted'), 'true');
  assert.equal(meta(a, 'reasoning_tokens'), '16000');
});

test('NEGATIVE TWIN: a normal answer says content_empty false and carries no retry marker', async () => {
  const a = await oneCall(async () => ({ content: 'fine', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 10, total: 11 } }), 'run_md-0000-4000-8000-000000000004');
  assert.equal(meta(a, 'content_empty'), 'false');
  assert.equal(meta(a, 'finish_reason'), 'stop');
  assert.equal(meta(a, 'reasoning_retry'), undefined);
});

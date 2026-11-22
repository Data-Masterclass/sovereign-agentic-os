/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The platform admin's Langfuse masking switch, applied by the one Langfuse writer
 * USER STORY: As a platform admin I switch masking on in Platform → Settings and, from then on, a
 *             customer's e-mail address or IBAN typed into an agent run never leaves os-ui for
 *             Langfuse; switched off, traces are what they were. Model, tokens, latency, tool
 *             names and decisions stay, so Monitoring keeps working.
 * ARCHITECTURE: the REAL `NodeSDK` + `LangfuseSpanProcessor` (in-memory exporter) driven by the
 *             real engine, as `run-trace.test.ts` does. The mask is Langfuse's documented
 *             `mask` option of the span processor; the setting is read live, so the same process
 *             flips between the cases below with no restart. The real-server proof (Langfuse
 *             container, ingestion payload captured) is `masking.e2e.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { runGraphEngine } from '@tabs/agents/lib/engine/run';
import { memoryCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { SHAPE_SINGLE_READ_YAML, graphDeps, scriptedLlm, type HoldSink } from '@tabs/agents/lib/engine/parity-harness';
import { __setForTests } from '@tabs/admin/lib/settings';
import { __useSpanExporterForTests, flushLangfuse, langfuseTraceId, recordObservation, withRunTrace } from '@core/infra/langfuse';

const exporter = new InMemorySpanExporter();
__useSpanExporterForTests(exporter);

const EMAIL = 'maria.keller@example-customer.de';
const IBAN = 'DE89370400440532013000';
const PHRASE = 'Refund the invoice for the Keller account';
const TASK = `${PHRASE}. Contact ${EMAIL}, IBAN ${IBAN}, phone +49 170 1234567.`;

const everything = (spans: ReadableSpan[]): string => JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, status: s.status })));
beforeEach(() => { exporter.reset(); __setForTests({ langfuseMasking: { enabled: false, level: 'pii' } } as never); });

async function runWithPii(runId: string): Promise<ReadableSpan[]> {
  const sys = parseSystem(SHAPE_SINGLE_READ_YAML);
  const sink: HoldSink = { enqueued: [] };
  const llm = async (req: Parameters<ReturnType<typeof scriptedLlm>>[0]) => ({ ...(await scriptedLlm(TASK)(req)), usage: { input: 10, output: 5, total: 15 } });
  await withRunTrace(
    { runId, systemId: 'sys-mask', systemName: sys.system.name, userId: 'rae', domain: sys.system.domain, task: TASK, environment: 'test', principal: 'os-sys-mask' },
    (observe) => runGraphEngine({ ir: compile(sys), deps: { ...graphDeps(sys, 'sys-mask', llm, sink), observe }, messages: [{ role: 'user', content: TASK }], runId, checkpointer: memoryCheckpointer() }),
  );
  await flushLangfuse();
  const traceId = await langfuseTraceId(runId);
  return exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
}

test('MASKING OFF (default): the seeded e-mail and IBAN are in the exported spans — what the OS records today', async () => {
  const spans = await runWithPii('run_mask-0000-4000-8000-000000000001');
  const all = everything(spans);
  assert.ok(all.includes(EMAIL), 'the e-mail reaches the exporter when masking is off (the negative twin of the next test)');
  assert.ok(all.includes(IBAN), 'the IBAN reaches the exporter when masking is off');
});

test('MASKING ON (pii): neither the e-mail, the IBAN nor the phone number reaches the exporter; the replacement and the structure do', async () => {
  __setForTests({ langfuseMasking: { enabled: true, level: 'pii' } } as never);
  const spans = await runWithPii('run_mask-0000-4000-8000-000000000002');
  const all = everything(spans);
  assert.ok(spans.length > 3, 'the run produced its spans');
  for (const secret of [EMAIL, IBAN, '1234567', 'maria.keller']) assert.ok(!all.includes(secret), `${secret} must not be exported with masking on`);
  assert.ok(all.includes('[email]') && all.includes('[iban]') && all.includes('[phone]'), 'the PII is replaced, not dropped');
  assert.ok(all.includes(PHRASE), 'the pii level keeps the non-PII words (it removes personal data, not content)');
  // What Monitoring reads is untouched: tool names, the decision, the call id, the model.
  assert.ok(spans.some((s) => s.name.startsWith('tool.')), 'tool names are kept');
  assert.match(all, /"decision":"ok"|decision.{0,6}ok/, 'the governance decision is kept');
  assert.ok(spans.some((s) => /litellm_call_id/.test(JSON.stringify(s.attributes))), 'the llm span still carries the call id that joins it to the gateway generation');
});

test('MASKING ON (content): no message, task, tool argument or result text is exported; metadata is', async () => {
  __setForTests({ langfuseMasking: { enabled: true, level: 'content' } } as never);
  const spans = await runWithPii('run_mask-0000-4000-8000-000000000003');
  const all = everything(spans);
  for (const secret of [EMAIL, IBAN, PHRASE, 'Keller', 'FINAL(']) assert.ok(!all.includes(secret), `${secret} must not be exported at the content level`);
  assert.ok(spans.some((s) => s.name.startsWith('tool.')), 'tool names are kept');
  assert.ok(spans.some((s) => s.name.startsWith('llm.')), 'the model-call spans are kept');
  assert.ok(spans.some((s) => s.name === 'run.result'), 'the run result event is kept');
  assert.ok(spans.some((s) => /litellm_call_id/.test(JSON.stringify(s.attributes))), 'the call id is kept');
  assert.match(all, /"chars"/, 'sizes are kept in place of text');
});

test('the switch is read live: ON then OFF in one process, no restart', async () => {
  __setForTests({ langfuseMasking: { enabled: true, level: 'pii' } } as never);
  assert.ok(!everything(await runWithPii('run_mask-0000-4000-8000-000000000004')).includes(EMAIL));
  exporter.reset();
  __setForTests({ langfuseMasking: { enabled: false, level: 'pii' } } as never);
  assert.ok(everything(await runWithPii('run_mask-0000-4000-8000-000000000005')).includes(EMAIL));
});

test('an error message and a standalone observation are masked too (not only the run tree)', async () => {
  __setForTests({ langfuseMasking: { enabled: true, level: 'pii' } } as never);
  await withRunTrace(
    { runId: 'run_mask-0000-4000-8000-000000000006', systemId: 'sys-mask', systemName: 'm', userId: 'rae', domain: 'sales' },
    async (observe) => { observe.span('node').end({ error: `refused for ${EMAIL}` }); observe.finish({ reachedEnd: false, parked: false, interrupted: false, failed: true, path: [], finalChars: 0, stepsUsed: 0 }); },
  );
  recordObservation({ name: 'tool.query', asType: 'tool', input: { sql: `select * from c where mail='${EMAIL}'` }, output: { rows: [{ iban: IBAN }] } });
  await flushLangfuse();
  const all = everything(exporter.getFinishedSpans());
  assert.ok(!all.includes(EMAIL) && !all.includes(IBAN), 'status message, standalone input and standalone output are scrubbed');
  assert.ok(all.includes('tool.query'), 'and the observation is still there');
});

test('standalone observation at the content level: input and output become sizes', async () => {
  __setForTests({ langfuseMasking: { enabled: true, level: 'content' } } as never);
  recordObservation({ name: 'tool.query', asType: 'tool', input: { sql: 'select secret_column from t' }, output: { rows: [1, 2] }, metadata: { kind: 'data', rows: 2 } });
  await flushLangfuse();
  const all = everything(exporter.getFinishedSpans());
  assert.ok(!all.includes('secret_column'));
  assert.ok(all.includes('"kind":"data"') || all.includes('kind'), 'metadata is kept');
});

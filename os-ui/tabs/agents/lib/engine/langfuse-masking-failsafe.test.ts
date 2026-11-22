/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Langfuse masking switch fails SAFE: not knowing the switch masks, never exports
 * USER STORY: As a platform admin who switched masking on, I never find a customer's e-mail address
 *             in a trace because a pod had just restarted, or the settings store could not be read
 *             at that moment. Until the switch has been READ, the OS behaves as "all content masked".
 * ARCHITECTURE: the REAL `NodeSDK` + `LangfuseSpanProcessor` (in-memory exporter) and the REAL
 *             settings store; only the settings store's transport (the OpenSearch mirror) is
 *             stand-in, because "unreachable" has to be producible on demand. Every case has a
 *             negative twin in which the store answers, so a writer that always masks cannot pass.
 *             The real-container proof (Langfuse + LiteLLM) is `masking.e2e.test.ts`.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';

type Read = { state: 'found'; doc: unknown } | { state: 'absent' } | { state: 'unreachable' };
let ANSWER: () => Promise<Read> = async () => ({ state: 'unreachable' });
let READS = 0;
mock.module('@core/infra/os-mirror', {
  namedExports: {
    osMirror: () => ({
      read: async () => { READS++; return ANSWER(); },
      getDoc: async () => { const r = await ANSWER(); return r.state === 'found' ? r.doc : null; },
      writeThrough: () => undefined,
      __reset: () => undefined,
    }),
  },
});

const { _reset } = await import('@tabs/admin/lib/settings');
const { __useSpanExporterForTests, flushLangfuse, recordObservation, withRunTrace, exportMask } = await import('@core/infra/langfuse');
const { liveMasking, heldMasking, maskingStatus } = await import('@core/infra/masking-policy');

const exporter = new InMemorySpanExporter();
__useSpanExporterForTests(exporter);

const EMAIL = 'maria.keller@example-customer.de';
const PHRASE = 'Refund the invoice for the Keller account';
const everything = (spans: ReadableSpan[]): string => JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes })));
const stored = (masking: unknown): Read => ({ state: 'found', doc: { settings: { langfuseMasking: masking } } });

beforeEach(() => { _reset(); exporter.reset(); READS = 0; ANSWER = async () => ({ state: 'unreachable' }); });

async function traceWithPii(runId: string): Promise<string> {
  await withRunTrace(
    { runId, systemId: 'sys-fs', systemName: 'fs', userId: 'rae', domain: 'sales', task: `${PHRASE}. Contact ${EMAIL}` },
    async (observe) => {
      const span = observe.span('reader');
      span.end({ output: { note: `${PHRASE} ${EMAIL}` } });
      observe.finish({ reachedEnd: true, parked: false, interrupted: false, failed: false, path: ['reader'], finalChars: 3, stepsUsed: 1 });
    },
  );
  recordObservation({ name: 'tool.query', asType: 'tool', input: { sql: `select * from c where mail='${EMAIL}'` }, output: { rows: [{ who: PHRASE }] }, metadata: { kind: 'data' } });
  await flushLangfuse();
  return everything(exporter.getFinishedSpans());
}

test('RESTART BEFORE HYDRATION: the very first read in a fresh process, with the store unreachable, is the strictest level', async () => {
  const p = await liveMasking();
  assert.deepEqual(p, { enabled: true, level: 'content' });
  assert.deepEqual(heldMasking(), { enabled: true, level: 'content' }, 'the synchronous read is strict too, never the default OFF');
});

test('STORE UNREACHABLE: a run and a standalone observation export no e-mail and no message text', async () => {
  const all = await traceWithPii('run_fs-0000-4000-8000-000000000001');
  assert.ok(all.includes('tool.query') && all.includes('run.result'), 'the structure is exported');
  for (const secret of [EMAIL, 'maria.keller', PHRASE, 'Keller']) assert.ok(!all.includes(secret), `${secret} must not be exported while the switch is unknown`);
});

test('STORE UNREACHABLE: the unknown state is logged and surfaced, not silent', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    await liveMasking();
    assert.ok(warn.mock.calls.some((c) => /masking/i.test(String(c.arguments[0])) && /unknown|unreadable|cannot be read/i.test(String(c.arguments[0]))), 'a warning names the unknown switch');
  } finally { warn.mock.restore(); }
  assert.deepEqual(maskingStatus(), { known: false, effective: { enabled: true, level: 'content' } });
});

test('a settings read that THROWS is the same as unreachable: masked, nothing thrown into the caller', async () => {
  ANSWER = async () => { throw new Error('boom'); };
  assert.deepEqual(await liveMasking(), { enabled: true, level: 'content' });
  const all = await traceWithPii('run_fs-0000-4000-8000-000000000002');
  assert.ok(!all.includes(EMAIL));
});

test('NEGATIVE TWIN: the store answers "masking OFF" - the very same writer exports the words (the switch is honoured, not ignored)', async () => {
  ANSWER = async () => stored({ enabled: false, level: 'pii' });
  const all = await traceWithPii('run_fs-0000-4000-8000-000000000003');
  assert.ok(all.includes(EMAIL) && all.includes(PHRASE), 'OFF means off once it has been read');
  assert.deepEqual(maskingStatus(), { known: true, effective: { enabled: false, level: 'pii' } });
});

test('NEGATIVE TWIN: the store has no settings document at all (404) - a fresh install is OFF, and that is a known answer', async () => {
  ANSWER = async () => ({ state: 'absent' });
  assert.deepEqual(await liveMasking(), { enabled: false, level: 'pii' });
  assert.equal(maskingStatus().known, true);
});

test('NEGATIVE TWIN: the store answers "pii" - the pii level applies, the words stay', async () => {
  ANSWER = async () => stored({ enabled: true, level: 'pii' });
  const all = await traceWithPii('run_fs-0000-4000-8000-000000000004');
  assert.ok(!all.includes(EMAIL), 'personal data is replaced');
  assert.ok(all.includes('Refund the invoice'), 'the pii level keeps the other words');
});

test('RECOVERY: once the store answers, the next read (after the retry interval) uses the saved value - the unknown state does not stick', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    assert.deepEqual(await liveMasking(), { enabled: true, level: 'content' });
    const first = READS;
    await liveMasking();
    assert.equal(READS, first, 'not re-read on every call while unknown (rate limited)');
    ANSWER = async () => stored({ enabled: false, level: 'pii' });
    mock.timers.tick(6000);
    assert.deepEqual(await liveMasking(), { enabled: false, level: 'pii' }, 'the saved OFF is read as soon as the store is back');
  } finally { mock.timers.reset(); }
});

test('a switch an admin turned ON stays ON across the unreachable store: unknown never reads OFF', async () => {
  ANSWER = async () => stored({ enabled: true, level: 'pii' });
  assert.deepEqual(await liveMasking(), { enabled: true, level: 'pii' });
  assert.deepEqual(heldMasking(), { enabled: true, level: 'pii' });
});

// ------------------------------------------------- export-time enforcement --

test('EXPORT MASK at the content level reduces text the writer did not reduce, keeps structure; the twins keep it', async () => {
  ANSWER = async () => stored({ enabled: true, level: 'content' });
  const raw = JSON.stringify({ sql: 'select secret_column from t', tool: 'query_data', rows: 2 });
  const out = JSON.parse((await exportMask({ data: raw })) as string);
  assert.ok(!JSON.stringify(out).includes('secret_column'));
  assert.equal(out.tool, 'query_data');
  assert.equal(out.rows, 2);

  _reset(); ANSWER = async () => stored({ enabled: true, level: 'pii' });
  assert.ok(String(await exportMask({ data: raw })).includes('secret_column'), 'pii level: words stay');
  _reset(); ANSWER = async () => stored({ enabled: false, level: 'pii' });
  assert.equal(await exportMask({ data: raw }), raw, 'off: untouched');
});

test('STANDALONE OBSERVATION at the content level: metadata text is reduced to sizes, numbers and structural words stay', async () => {
  ANSWER = async () => stored({ enabled: true, level: 'content' });
  await liveMasking();
  recordObservation({ name: 'tool.query', asType: 'tool', input: { sql: 'select 1' }, output: { rows: [1] }, metadata: { kind: 'data', rows: 2, customer: 'Keller GmbH', comment: `ping ${EMAIL}` } });
  await flushLangfuse();
  const all = everything(exporter.getFinishedSpans());
  assert.ok(!all.includes('Keller') && !all.includes(EMAIL), 'metadata text is not exported');
  assert.ok(all.includes('"kind":"data"') && all.includes('"rows":2'), 'metadata structure is');
});

test('RUN RESULT and SEGMENT OUTPUT at the content level: nothing but structure leaves, even if the outcome carries text', async () => {
  ANSWER = async () => stored({ enabled: true, level: 'content' });
  await withRunTrace(
    { runId: 'run_fs-0000-4000-8000-000000000009', systemId: 'sys-fs', systemName: 'fs', userId: 'rae', domain: 'sales' },
    async (observe) => {
      observe.finish({ reachedEnd: true, parked: false, interrupted: false, failed: false, path: ['reader'], finalChars: 3, stepsUsed: 1, finalText: PHRASE } as never);
    },
  );
  await flushLangfuse();
  const spans = exporter.getFinishedSpans();
  const all = everything(spans);
  assert.ok(spans.some((s) => s.name === 'run.result'));
  assert.ok(!all.includes('Keller') && !all.includes(PHRASE), 'neither run.result nor the segment output carries the text');
  assert.ok(all.includes('"reachedEnd":true'), 'while the outcome flags stay');
});

test('RUN RESULT NEGATIVE TWIN: with masking OFF the outcome is exported as it is', async () => {
  ANSWER = async () => stored({ enabled: false, level: 'pii' });
  await withRunTrace(
    { runId: 'run_fs-0000-4000-8000-000000000010', systemId: 'sys-fs', systemName: 'fs', userId: 'rae', domain: 'sales' },
    async (observe) => { observe.finish({ reachedEnd: true, parked: false, interrupted: false, failed: false, path: ['reader'], finalChars: 3, stepsUsed: 1, finalText: PHRASE } as never); },
  );
  await flushLangfuse();
  assert.ok(everything(exporter.getFinishedSpans()).includes(PHRASE));
});

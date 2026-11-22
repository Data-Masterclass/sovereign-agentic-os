/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse masking switch, os-ui side — proof on the REAL Langfuse server
 * USER STORY: As a platform admin who switched masking on I want proof from Langfuse's own side
 *             that an e-mail address and an IBAN typed into an agent run never reached it — in
 *             the ingestion payload os-ui sent and in the stored trace — while model, tokens,
 *             cost, latency, tool names and the run status are all still there for Monitoring.
 * ARCHITECTURE:
 *   - Stack: `tests/langfuse/compose.yaml` (Langfuse 3.194.1 + production LiteLLM, message
 *     logging OFF as in the chart). Skipped unless `TRACING_E2E=1`.
 *   - os-ui sends to a RECORDING FORWARDER in front of the real Langfuse web container
 *     (`masking-e2e-harness.ts`): the exact ingestion payload is captured and relayed.
 *   - The run is the REAL engine through the REAL gateway; the setting is the platform setting
 *     (`langfuseMasking`), flipped in-process between runs — no restart.
 *   - NEGATIVE TWIN: with masking OFF the same seeded values ARE in the captured payload and in
 *     the stored trace; so an empty capture can never pass the ON cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SEED, SEEDED_TASK, contains, settledTrace, startRecordingForwarder, startStubModel, tracedRun, type RunKit } from '@tabs/agents/lib/engine/fixtures/masking-e2e-harness';

const E2E = process.env.TRACING_E2E === '1';
const LITELLM = process.env.LITELLM_E2E_URL ?? `http://127.0.0.1:${process.env.LITELLM_E2E_PORT ?? '14031'}`;
const skip = !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml up';

const forwarder = E2E ? await startRecordingForwarder() : null;
if (forwarder) process.env.LANGFUSE_URL = forwarder.url;
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-e2e-public';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-e2e-secret';
process.env.LITELLM_URL = LITELLM;
const { __setMaskingForTests } = await import('@core/infra/masking-policy');
const { _reset: restartSettings } = await import('@tabs/admin/lib/settings');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { compile } = await import('@tabs/agents/lib/langgraph-compile');
const { runGraphEngine } = await import('@tabs/agents/lib/engine/run');
const { memoryCheckpointer } = await import('@tabs/agents/lib/engine/checkpointer');
const { SHAPE_SINGLE_READ_YAML, graphDeps, scriptedLlm } = await import('@tabs/agents/lib/engine/parity-harness');
const { liteLlmCaller } = await import('@core/runtime/runtime');
const kit = { parseSystem, compile, runGraphEngine, memoryCheckpointer, shapeYaml: SHAPE_SINGLE_READ_YAML, graphDeps, liteLlmCaller } as unknown as RunKit;
const { shapeTraceMetrics } = await import('@tabs/agents/lib/build/run-diagnostics');

type Level = 'pii' | 'content';
async function runWith(masking: { enabled: boolean; level: Level } | 'restarted') {
  // 'restarted': a fresh process whose settings were never read and whose store cannot be read
  // (this stack has no settings store) - the switch is UNKNOWN, which must mask like "all content".
  if (masking === 'restarted') restartSettings(); else __setMaskingForTests(masking);
  const stub = await startStubModel(scriptedLlm(SEEDED_TASK));
  try {
    const before = forwarder!.recorded.length;
    const runId = `run_${randomUUID()}`;
    const { result, traceId } = await tracedRun(runId, kit);
    assert.equal(result.reachedEnd, true, 'the run completed through the real gateway');
    const calls = stub.calls();
    const trace = await settledTrace(traceId, calls);
    const sent = forwarder!.recorded.slice(before).filter((r) => /\/api\/public\/(otel|ingestion)/.test(r.url));
    return { trace, calls, payload: sent.map((r) => r.body).join('\n'), payloadParts: sent.length };
  } finally {
    stub.server.close();
  }
}

test('MASKING OFF (negative twin): the seeded e-mail, IBAN and phone ARE in the ingestion payload and in the stored trace', { skip }, async () => {
  const r = await runWith({ enabled: false, level: 'pii' });
  assert.ok(r.payloadParts > 0 && r.payload.includes('run.result'), 'the capture holds the run\'s ingestion payload');
  const stored = JSON.stringify(r.trace);
  for (const v of [SEED.email, SEED.iban, SEED.phone]) {
    assert.ok(contains(r.payload, v), `${v} is in the captured payload with masking off`);
    assert.ok(contains(stored, v), `${v} is in the stored trace with masking off`);
  }
});

test('MASKING ON (pii): no seeded personal data in the ingestion payload or the stored trace; tokens, cost, latency, tool names, status remain', { skip }, async () => {
  const r = await runWith({ enabled: true, level: 'pii' });
  assert.ok(r.payloadParts > 0 && r.payload.includes('run.result'), 'the capture holds the run\'s ingestion payload');
  const stored = JSON.stringify(r.trace);
  for (const v of [SEED.email, SEED.iban, SEED.phone, 'maria.keller']) {
    assert.ok(!contains(r.payload, v), `${v} must not be in the ingestion payload`);
    assert.ok(!contains(stored, v), `${v} must not be in the stored trace`);
  }
  assert.ok(stored.includes('[email]') && stored.includes('[iban]'), 'the values are replaced, not removed');
  // Monitoring still has everything it reads.
  const gens = r.trace.observations.filter((o) => o.type === 'GENERATION');
  assert.equal(gens.length, r.calls);
  assert.equal(gens.reduce((n, g) => n + (g.usage?.total ?? 0), 0), 15 * r.calls, 'tokens');
  assert.ok(gens.every((g) => (g.calculatedTotalCost ?? 0) > 0), 'cost');
  assert.ok(gens.every((g) => typeof g.latency === 'number' && g.latency >= 0), 'latency');
  assert.ok(gens.every((g) => g.model), 'model');
  assert.ok(r.trace.observations.some((o) => o.type === 'TOOL' && o.name.startsWith('tool.')), 'tool names');
  assert.ok(r.trace.observations.some((o) => o.name === 'run.result'), 'run status');
  assert.equal(r.trace.userId, 'rae');
  assert.equal(r.trace.sessionId, 'system:sys-e2e-mask');
  assert.equal(shapeTraceMetrics(r.trace.observations as never, ['reader']).perNode.reader?.tokens, 15 * r.calls, 'per-agent tokens (run diagnostics) still attribute');
});

test('MASKING ON (content): no message, task, argument or result text at all; metadata and structure remain', { skip }, async () => {
  const r = await runWith({ enabled: true, level: 'content' });
  const stored = JSON.stringify(r.trace);
  for (const v of [SEED.email, SEED.iban, SEED.phone, SEED.phrase, 'Keller', 'FINAL(']) {
    assert.ok(!contains(r.payload, v), `${v} must not be in the ingestion payload`);
    assert.ok(!contains(stored, v), `${v} must not be in the stored trace`);
  }
  const gens = r.trace.observations.filter((o) => o.type === 'GENERATION');
  assert.equal(gens.reduce((n, g) => n + (g.usage?.total ?? 0), 0), 15 * r.calls, 'tokens');
  assert.ok(gens.every((g) => (g.calculatedTotalCost ?? 0) > 0), 'cost');
  assert.ok(r.trace.observations.some((o) => o.type === 'TOOL' && o.name.startsWith('tool.')), 'tool names');
  assert.ok(r.trace.observations.some((o) => o.name === 'run.result'), 'run status');
});

test('the gateway of the chart (message logging off) records no content in any mode — today\'s behaviour is unchanged', { skip }, async () => {
  const off = await runWith({ enabled: false, level: 'pii' });
  for (const g of off.trace.observations.filter((o) => o.type === 'GENERATION')) {
    assert.ok(!contains(JSON.stringify(g), SEED.email), 'the gateway generation holds no prompt text even with masking off');
  }
});

test('RESTART BEFORE HYDRATION (settings never read, store unreachable): the real Langfuse receives no seeded text at all - the strictest level applies', { skip }, async () => {
  const r = await runWith('restarted');
  const stored = JSON.stringify(r.trace);
  assert.ok(r.payloadParts > 0 && r.payload.includes('run.result'), 'the capture holds the run\'s ingestion payload');
  for (const v of [SEED.email, SEED.iban, SEED.phone, SEED.phrase, 'Keller', 'FINAL(']) {
    assert.ok(!contains(r.payload, v), `${v} must not be in the ingestion payload`);
    assert.ok(!contains(stored, v), `${v} must not be in the stored trace`);
  }
  assert.ok(r.trace.observations.some((o) => o.type === 'TOOL' && o.name.startsWith('tool.')), 'the structure (tool names) is still there');
  // NEGATIVE TWIN: once the switch is known to be OFF, the same stack carries the seeded text again.
  const off = await runWith({ enabled: false, level: 'pii' });
  assert.ok(contains(JSON.stringify(off.trace), SEED.email), 'a run that is not masked would have shown it');
});

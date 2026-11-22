/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse masking switch, gateway side — LiteLLM's callback path respects it
 * USER STORY: As a platform admin I switch masking on and, from the next model call, the gateway's
 *             own Langfuse record of that call carries no prompt or completion text — even when
 *             an operator has the gateway's message logging switched on — while model, usage and
 *             cost stay. No redeploy, no restart.
 * ARCHITECTURE:
 *   - Stack: `tests/langfuse/compose.yaml` plus `compose.masking.yaml`: Langfuse 3.194.1 and a
 *     SECOND production LiteLLM (1.109.1, `langfuse_otel`) with `turn_off_message_logging: false`,
 *     the gateway whose content is visible. Skipped unless `TRACING_E2E=1`.
 *   - The mechanism is LiteLLM's documented per-request header `x-litellm-enable-message-redaction`
 *     (https://docs.litellm.ai/docs/proxy/logging#redact-messages-response-content), sent by the
 *     OS on every run-path model call while the platform setting is ON.
 *   - NEGATIVE TWIN: with masking OFF the very same gateway DOES record the seeded e-mail in its
 *     generation, so a gateway that records nothing can never pass the ON case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SEED, SEEDED_TASK, contains, settledTrace, startRecordingForwarder, startStubModel, tracedRun, type RunKit } from '@tabs/agents/lib/engine/fixtures/masking-e2e-harness';

const E2E = process.env.TRACING_E2E === '1';
const LITELLM_CONTENT = process.env.LITELLM_CONTENT_E2E_URL ?? `http://127.0.0.1:${process.env.LITELLM_CONTENT_E2E_PORT ?? '14032'}`;
const skip = !E2E && 'set TRACING_E2E=1 with tests/langfuse/compose.yaml + compose.masking.yaml up';

const forwarder = E2E ? await startRecordingForwarder() : null;
if (forwarder) process.env.LANGFUSE_URL = forwarder.url;
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-e2e-public';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-e2e-secret';
process.env.LITELLM_URL = LITELLM_CONTENT;
const { __setMaskingForTests } = await import('@core/infra/masking-policy');
const { _reset: restartSettings } = await import('@tabs/admin/lib/settings');
const { parseSystem } = await import('@tabs/agents/lib/system-schema');
const { compile } = await import('@tabs/agents/lib/langgraph-compile');
const { runGraphEngine } = await import('@tabs/agents/lib/engine/run');
const { memoryCheckpointer } = await import('@tabs/agents/lib/engine/checkpointer');
const { SHAPE_SINGLE_READ_YAML, graphDeps, scriptedLlm } = await import('@tabs/agents/lib/engine/parity-harness');
const { liteLlmCaller } = await import('@core/runtime/runtime');
const kit = { parseSystem, compile, runGraphEngine, memoryCheckpointer, shapeYaml: SHAPE_SINGLE_READ_YAML, graphDeps, liteLlmCaller } as unknown as RunKit;

async function gatewayGenerations(masking: { enabled: boolean; level: 'pii' | 'content' } | 'restarted') {
  if (masking === 'restarted') restartSettings(); else __setMaskingForTests(masking);
  const stub = await startStubModel(scriptedLlm(SEEDED_TASK));
  try {
    const { result, traceId } = await tracedRun(`run_${randomUUID()}`, kit);
    assert.equal(result.reachedEnd, true);
    const calls = stub.calls();
    const trace = await settledTrace(traceId, calls);
    return { calls, gens: trace.observations.filter((o) => o.type === 'GENERATION') };
  } finally {
    stub.server.close();
  }
}

test('GATEWAY with message logging ON, masking OFF (negative twin): the generation carries the prompt, so the e-mail is there', { skip }, async () => {
  const { gens, calls } = await gatewayGenerations({ enabled: false, level: 'pii' });
  assert.equal(gens.length, calls);
  assert.ok(gens.some((g) => contains(JSON.stringify(g.input ?? null), SEED.email)), 'the gateway recorded the seeded e-mail in a generation input');
});

test('GATEWAY with message logging ON, masking ON (pii): no prompt or completion text in any generation; model, usage and cost remain', { skip }, async () => {
  const { gens, calls } = await gatewayGenerations({ enabled: true, level: 'pii' });
  assert.equal(gens.length, calls);
  for (const g of gens) {
    const text = JSON.stringify({ input: g.input ?? null, output: g.output ?? null });
    for (const v of [SEED.email, SEED.iban, SEED.phone, SEED.phrase]) assert.ok(!contains(text, v), `${v} must not be in the gateway's generation`);
    assert.ok(g.model, 'model');
    assert.equal(g.usage?.total, 15, 'usage');
    assert.ok((g.calculatedTotalCost ?? 0) > 0, 'cost');
  }
});

test('GATEWAY: the switch applies to the very next call — OFF again, the e-mail is back (no restart in between)', { skip }, async () => {
  await gatewayGenerations({ enabled: true, level: 'pii' });
  const { gens } = await gatewayGenerations({ enabled: false, level: 'pii' });
  assert.ok(gens.some((g) => contains(JSON.stringify(g.input ?? null), SEED.email)));
});

test('GATEWAY, RESTART BEFORE HYDRATION (settings never read, store unreachable): the call is redacted at the gateway - no prompt or completion in any generation', { skip }, async () => {
  const { gens, calls } = await gatewayGenerations('restarted');
  assert.equal(gens.length, calls);
  for (const g of gens) {
    const text = JSON.stringify({ input: g.input ?? null, output: g.output ?? null });
    for (const v of [SEED.email, SEED.iban, SEED.phone, SEED.phrase]) assert.ok(!contains(text, v), `${v} must not be in the gateway's generation`);
    assert.ok(g.model && g.usage?.total === 15, 'model and usage remain');
  }
  // NEGATIVE TWIN: the first test of this file (masking known OFF) shows the same gateway DOES record the e-mail.
});

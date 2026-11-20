/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The gateway's Langfuse generation, proven against the REAL LiteLLM and Langfuse images
 * USER STORY: As the owner I need proof, not a mock, that one model call is ONE generation in
 *             Langfuse, inside the trace of the work that made it, with the gateway's tokens and
 *             cost, and that the gateway still refuses a key whose budget is spent (10 F1, WP-32).
 * ARCHITECTURE:
 *   - Runs ONLY against live containers started by scripts/tests/litellm-langfuse/run.sh: the
 *     chart's LiteLLM image and config (`callbacks: ["langfuse_otel"]`, OTel v2) and Langfuse on
 *     its documented self-hosting stack. The model provider is a stub that always reports
 *     1000 input / 500 output tokens. In the ordinary unit run the variables are unset and the
 *     suite SKIPS, saying so; with TRACING_E2E_REQUIRED=1 a missing variable is a FAILURE.
 *   - The "app span" is what the OS's OTel writer (05 step 2) sends: one span over OTLP to
 *     Langfuse's own endpoint, with W3C ids. The model call then goes through os-ui's real gateway
 *     caller (`liteLlmCaller`), so the `traceparent` and `x-litellm-call-id` headers are the
 *     production code's.
 *   - Read back through Langfuse's public API (`GET /api/public/traces/{id}`, v3).
 *   - NEGATIVE TWIN: run.sh runs this file a second time against a gateway with the legacy
 *     `success_callback: ["langfuse"]` added. The generation-count assertion must fail then.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const LF = (process.env.LANGFUSE_E2E_URL ?? '').replace(/\/+$/, '');
const PK = process.env.LANGFUSE_E2E_PUBLIC_KEY ?? '';
const SK = process.env.LANGFUSE_E2E_SECRET_KEY ?? '';
const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const MASTER = process.env.LITELLM_E2E_MASTER_KEY ?? '';
const SCOPE = process.env.LITELLM_E2E_SPAN_SCOPE ?? 'full';
const REQUIRED = process.env.TRACING_E2E_REQUIRED === '1';
const skip = !LF && !REQUIRED ? 'LANGFUSE_E2E_URL is not set (run scripts/tests/litellm-langfuse/run.sh)' : false;

/** The stub provider's fixed usage, and the chart's `sovereign-default` prices per token. */
const STUB_USAGE = { input: 1000, output: 500, total: 1500 };
const PRICE = { input: 0.00000015, output: 0.00000025 };
const CANARY = 'PROMPT_CANARY_91c2';

const basic = `Basic ${Buffer.from(`${PK}:${SK}`).toString('base64')}`;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Obs = {
  id: string; type: string; name: string; parentObservationId: string | null;
  usage?: { input?: number; output?: number; total?: number };
  usageDetails?: Record<string, number>;
  calculatedTotalCost?: number | null; costDetails?: Record<string, number>;
  metadata?: unknown; input?: unknown; output?: unknown;
};

/** Send one app span over OTLP/HTTP JSON, the way an OTel exporter does. */
async function sendAppSpan(traceId: string, spanId: string, name: string): Promise<void> {
  const now = BigInt(Date.now()) * 1_000_000n;
  const body = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'os-ui' } }] },
      scopeSpans: [{
        scope: { name: 'tracing.e2e' },
        spans: [{
          traceId, spanId, name, kind: 1,
          startTimeUnixNano: String(now - 2_000_000_000n), endTimeUnixNano: String(now + 2_000_000_000n),
          attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'span' } }],
          status: { code: 1 },
        }],
      }],
    }],
  };
  const res = await fetch(`${LF}/api/public/otel/v1/traces`, {
    method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(res.ok, `Langfuse OTLP ingest of the app span answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The trace's observations, once the app span and at least one GENERATION are in, plus a settle window. */
async function observationsOf(traceId: string, appSpanId: string): Promise<Obs[]> {
  let last: Obs[] = [];
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${LF}/api/public/traces/${traceId}`, { headers: { authorization: basic } });
    if (res.ok) {
      last = ((await res.json()) as { observations?: Obs[] }).observations ?? [];
      if (last.some((o) => o.id === appSpanId) && last.some((o) => o.type === 'GENERATION')) break;
    }
    await sleep(2000);
  }
  // A second generation (the legacy callback) can arrive a few seconds after the first. Keep every
  // observation seen in any read: the trace read is eventually consistent.
  await sleep(10_000);
  const seen = new Map(last.map((o) => [o.id, o]));
  const res = await fetch(`${LF}/api/public/traces/${traceId}`, { headers: { authorization: basic } });
  if (res.ok) for (const o of ((await res.json()) as { observations?: Obs[] }).observations ?? []) seen.set(o.id, o);
  return [...seen.values()];
}

test('tracing e2e: the environment names Langfuse and the gateway', { skip }, () => {
  for (const [k, v] of Object.entries({ LANGFUSE_E2E_URL: LF, LANGFUSE_E2E_PUBLIC_KEY: PK, LANGFUSE_E2E_SECRET_KEY: SK, LITELLM_URL: GW, LITELLM_E2E_MASTER_KEY: MASTER })) {
    assert.ok(v, `${k} must be set when TRACING_E2E_REQUIRED=1`);
  }
});

test('tracing e2e: one model call is exactly one GENERATION, nested under the app span, with call id, tokens and cost', { skip, timeout: 240_000 }, async () => {
  const { liteLlmCaller } = await import('@core/runtime/runtime');
  const traceId = hex(16);
  const appSpanId = hex(8);
  await sendAppSpan(traceId, appSpanId, 'model-call');

  const call = liteLlmCaller({ userId: 'u-e2e', domain: 'sales', systemId: 'sys-e2e', tab: 'agents', runId: 'run-e2e' });
  const completion = await call({
    model: 'sovereign-default',
    messages: [{ role: 'system', content: `${CANARY} system` }, { role: 'user', content: `${CANARY} hello` }],
    observe: { traceId, parentObservationId: appSpanId },
  });
  assert.ok(completion.gatewayCallId, 'the caller returns the call id it sent as x-litellm-call-id');
  assert.deepEqual(
    { input: completion.usage?.input, output: completion.usage?.output },
    { input: STUB_USAGE.input, output: STUB_USAGE.output },
    'the gateway answered with the provider usage',
  );

  const obs = await observationsOf(traceId, appSpanId);
  const summary = obs.map((o) => `${o.type} ${o.name} id=${o.id} parent=${o.parentObservationId}`).join('\n  ');
  const gens = obs.filter((o) => o.type === 'GENERATION');
  assert.equal(gens.length, 1, `exactly one GENERATION per model call; trace ${traceId} has ${gens.length}:\n  ${summary}`);
  const gen = gens[0];

  // Nesting: the generation's parent chain stays inside this trace and reaches the app span.
  const byId = new Map(obs.map((o) => [o.id, o]));
  const chain: string[] = [];
  let cur: Obs | undefined = gen;
  while (cur?.parentObservationId && chain.length < 10) {
    chain.push(cur.parentObservationId);
    if (cur.parentObservationId === appSpanId) break;
    cur = byId.get(cur.parentObservationId);
    assert.ok(cur, `the GENERATION's ancestor ${chain.at(-1)} is not in the trace (it points at a span Langfuse never received):\n  ${summary}`);
  }
  assert.equal(chain.at(-1), appSpanId, `the GENERATION is nested under the app span via traceparent:\n  ${summary}`);
  if (SCOPE === 'llm_only') assert.equal(gen.parentObservationId, appSpanId, 'llm_only: the GENERATION is a direct child of the app span');
  if (SCOPE === 'full') assert.equal(chain.length, 2, 'full: GENERATION -> the gateway request span -> the app span');

  // The call id the OS sent (x-litellm-call-id) is the one the gateway reports: LiteLLM OTel v2
  // puts it in the span attribute `litellm.call_id`, which Langfuse keeps under metadata.attributes.
  const attrs = ((gen.metadata ?? {}) as { attributes?: Record<string, unknown> }).attributes ?? {};
  assert.equal(attrs['litellm.call_id'], completion.gatewayCallId, `the GENERATION carries the x-litellm-call-id (metadata ${JSON.stringify(gen.metadata).slice(0, 300)})`);

  // Tokens and cost: the provider's usage once (no doubling) and the chart's price.
  const usage = gen.usageDetails ?? {};
  assert.equal(usage.input ?? gen.usage?.input, STUB_USAGE.input, `input tokens on the GENERATION: ${JSON.stringify(gen.usageDetails ?? gen.usage)}`);
  assert.equal(usage.output ?? gen.usage?.output, STUB_USAGE.output, 'output tokens on the GENERATION');
  const expected = STUB_USAGE.input * PRICE.input + STUB_USAGE.output * PRICE.output;
  const cost = Number(gen.calculatedTotalCost ?? gen.costDetails?.total ?? 0);
  assert.ok(Math.abs(cost - expected) < 1e-9, `cost on the GENERATION is the gateway's priced cost ${expected}, got ${cost} (${JSON.stringify(gen.costDetails)})`);

  // No message content reached Langfuse from the gateway.
  const gatewayObs = obs.filter((o) => o.id !== appSpanId);
  assert.ok(!JSON.stringify(gatewayObs).includes(CANARY), 'no prompt content in any gateway observation');
  assert.ok(!JSON.stringify(gatewayObs).includes('COMPLETION_CANARY_7f3a'), 'no completion content in any gateway observation');
});

test('tracing e2e: a virtual key whose budget is spent is refused, and the OS reads it as a spent budget', { skip, timeout: 180_000 }, async () => {
  const { liteLlmCaller } = await import('@core/runtime/runtime');
  const { putSecret } = await import('@core/infra/secrets');
  const { BudgetExceededError } = await import('@core/infra/litellm-credential');
  const key = `sk-e2e-budget-${hex(6)}`;
  // One call costs 0.000275 at the chart's prices; the second call spends past this budget.
  const gen = await fetch(`${GW}/key/generate`, {
    method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key, key_alias: `e2e-budget-${hex(3)}`, models: ['sovereign-default'], max_budget: 0.0004, budget_duration: '7d' }),
  });
  assert.equal(gen.status, 200, `/key/generate: ${(await gen.text()).slice(0, 200)}`);
  const keyRef = putSecret('e2e-system-key', 'apiKey', key);
  const call = liteLlmCaller({ userId: 'u-e2e', domain: 'sales', systemId: 'sys-budget', keyRef });
  const req = { model: 'sovereign-default', messages: [{ role: 'user' as const, content: 'spend' }] };

  let refused: unknown = null;
  let served = 0;
  for (let i = 0; i < 12 && !refused; i++) {
    try {
      await call(req);
      served++;
    } catch (e) {
      refused = e;
    }
    await sleep(3000); // the gateway books spend asynchronously
  }
  assert.ok(served >= 1, 'the key served at least one call before its budget ran out');
  assert.ok(refused instanceof BudgetExceededError, `a spent budget is a BudgetExceededError, got: ${String((refused as Error)?.message ?? refused).slice(0, 300)}`);
});

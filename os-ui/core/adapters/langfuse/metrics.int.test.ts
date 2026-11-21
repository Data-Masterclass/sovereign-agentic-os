/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Per-agent-system latency, trace count and tokens from the REAL Langfuse Metrics API.
 * USER STORY: As an agentic engineer I want p50/p95 latency and tokens per agent system to be what
 *             Langfuse computes over its own traces, not a percentile the OS works out.
 * ARCHITECTURE:
 *   - Stack: tests/langfuse/compose.yaml (Langfuse 3.194.1, the production pin). Skipped unless
 *     TRACING_E2E=1 (the CI job that starts that stack).
 *   - Fixture traces go in through Langfuse's public ingestion API, shaped like an OS run trace:
 *     session `system:<id>` (trace-port.ts runSessionId), one generation with usage.
 *   - Read: `GET /api/public/metrics` (view traces, dimension sessionId, latency p50/p95,
 *     totalTokens sum) — https://langfuse.com/docs/metrics/features/metrics-api
 *   - Negative twins: a system outside the asked set is not in the answer; wrong keys are
 *     `unauthorized`, never an empty success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { systemTraceStats } from './metrics';

const on = process.env.TRACING_E2E === '1';
const BASE = process.env.LANGFUSE_E2E_URL ?? `http://127.0.0.1:${process.env.LANGFUSE_E2E_PORT ?? '13031'}`;
const KEYS = { publicKey: 'pk-lf-e2e-public', secretKey: 'sk-lf-e2e-secret' };
const AUTH = 'Basic ' + Buffer.from(`${KEYS.publicKey}:${KEYS.secretKey}`).toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ingestRun(systemId: string, ms: number, tokens: number): Promise<void> {
  const t0 = new Date(Date.now() - 60_000);
  const t1 = new Date(t0.getTime() + ms);
  const traceId = randomUUID();
  const batch = [
    { id: randomUUID(), type: 'trace-create', timestamp: t0.toISOString(), body: { id: traceId, name: 'agent-run', sessionId: `system:${systemId}`, tags: [`system:${systemId}`], timestamp: t0.toISOString() } },
    { id: randomUUID(), type: 'generation-create', timestamp: t0.toISOString(), body: { id: randomUUID(), traceId, name: 'llm', startTime: t0.toISOString(), endTime: t1.toISOString(), model: 'stub', usage: { input: tokens - 10, output: 10, total: tokens } } },
  ];
  const r = await fetch(`${BASE}/api/public/ingestion`, { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ batch }) });
  assert.equal(r.status, 207, await r.text());
}

test('systemTraceStats reads p50/p95 latency, traces and tokens per system from Langfuse', { skip: !on }, async () => {
  const a = `mon-a-${randomUUID().slice(0, 6)}`;
  const b = `mon-b-${randomUUID().slice(0, 6)}`;
  await ingestRun(a, 1000, 100);
  await ingestRun(a, 3000, 200);
  await ingestRun(b, 5000, 999);
  const from = new Date(Date.now() - 3_600_000);
  const to = new Date(Date.now() + 60_000);
  let stats: Awaited<ReturnType<typeof systemTraceStats>> | null = null;
  for (let i = 0; i < 40; i++) {
    stats = await systemTraceStats([a], { from, to, base: BASE, ...KEYS });
    assert.ok(stats.ok, JSON.stringify(stats));
    if (stats.ok && (stats.value.get(a)?.traces ?? 0) >= 2) break;
    await sleep(1500);
  }
  assert.ok(stats && stats.ok);
  const s = stats.value.get(a);
  assert.ok(s, `no stats for ${a}`);
  assert.equal(s.traces, 2);
  assert.equal(s.tokens, 300);
  assert.ok(s.p50Ms !== null && s.p50Ms >= 1000 && s.p50Ms <= 3000, `p50 ${s.p50Ms}`);
  assert.ok(s.p95Ms !== null && s.p95Ms >= s.p50Ms && s.p95Ms <= 3000, `p95 ${s.p95Ms}`);
  // Negative twin: system b was not asked for and is not in the answer.
  assert.equal(stats.value.has(b), false);
});

test('systemTraceStats: wrong keys are unauthorized, no systems asks Langfuse nothing', { skip: !on }, async () => {
  const bad = await systemTraceStats(['x'], { from: new Date(Date.now() - 3_600_000), to: new Date(), base: BASE, publicKey: 'pk-wrong', secretKey: 'sk-wrong' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, 'unauthorized');
  const none = await systemTraceStats([], { from: new Date(Date.now() - 3_600_000), to: new Date(), base: 'http://127.0.0.1:1', ...KEYS });
  assert.ok(none.ok);
  assert.equal(none.value.size, 0);
});

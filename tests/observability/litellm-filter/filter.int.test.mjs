/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-05 option for WP-32 — the Collector drops LiteLLM's parentless spans (its
 *             background polls under span scope `full`) before they reach Langfuse.
 * USER STORY: As an operator I want Langfuse to hold the gateway's generations nested under the
 *             caller's trace, without a stream of idle database-poll traces.
 * ARCHITECTURE:
 *   - Driven by run.sh: real LiteLLM 1.109.1 -> the chart-rendered Collector -> an auth-checking
 *     sink that writes OTLP JSON lines to FILTER_SPANS.
 *   - Idle window: count LiteLLM spans with no parentSpanId that arrived during 30 s of idling.
 *     FILTER_MODE=on: must be 0 AND the Collector's own counter must show spans received from
 *     LiteLLM in that window (so "0" cannot mean "nothing was sent"). FILTER_MODE=off (negative
 *     twin): must be > 0.
 *   - Generation: one /chat/completions with a W3C `traceparent`; its trace must reach the sink in
 *     BOTH modes, with the caller's span as the parent of its top span.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const on = process.env.FILTER_IT === '1';
const mode = process.env.FILTER_MODE;
const FILE = process.env.FILTER_SPANS;
const LITELLM = 'http://127.0.0.1:14000';
const COLLECTOR_METRICS = 'http://127.0.0.1:18890/metrics';

/** Sum of a Collector self-metric (Prometheus text), optionally only series matching `filter`. */
async function selfMetric(name, filter = '') {
  const text = await (await fetch(COLLECTOR_METRICS)).text();
  return text.split('\n').filter((l) => l.startsWith(name) && l.includes(filter)).reduce((n, l) => n + Number(l.split(' ').pop()), 0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every span in the sink file: { service, name, traceId, spanId, parentSpanId, startNs }. */
function spans() {
  if (!existsSync(FILE)) return [];
  const out = [];
  for (const line of readFileSync(FILE, 'utf8').split('\n').filter(Boolean)) {
    for (const rs of JSON.parse(line).resourceSpans ?? []) {
      const service = (rs.resource?.attributes ?? []).find((a) => a.key === 'service.name')?.value?.stringValue;
      for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
        out.push({ service, name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId ?? '', startNs: BigInt(s.startTimeUnixNano ?? 0) });
      }
    }
  }
  return out;
}

test(`idle LiteLLM poll spans (no parent) are ${mode === 'on' ? 'DROPPED' : 'EXPORTED (negative twin)'}`, { skip: !on }, async () => {
  await sleep(10_000); // let start-up settle
  const from = BigInt(Date.now()) * 1_000_000n;
  const received0 = await selfMetric('otelcol_receiver_accepted_spans', 'otlp/litellm_langfuse');
  await sleep(30_000);
  const received = (await selfMetric('otelcol_receiver_accepted_spans', 'otlp/litellm_langfuse')) - received0;
  console.log(`the Collector accepted ${received} span(s) from LiteLLM in the idle window`);
  assert.ok(received > 0, 'LiteLLM sent the Collector nothing while idle — the test would prove nothing');
  const all = spans();
  const roots = all.filter((s) => s.startNs >= from && s.service === 'litellm' && !s.parentSpanId);
  const names = [...new Set(roots.map((s) => s.name))].slice(0, 8);
  console.log(`mode=${mode}: ${all.length} span(s) in the sink; ${roots.length} parentless litellm span(s) in 30 s idle (${(roots.length / 30).toFixed(3)}/s): ${names.join(', ')}`);
  if (mode === 'on') assert.equal(roots.length, 0, `filter on, yet parentless spans arrived: ${names.join(', ')}`);
  else assert.ok(roots.length > 0, 'filter off and no idle poll span arrived — the twin cannot prove the filter does anything');
});

test('a real generation called with a traceparent reaches Langfuse, nested under the caller', { skip: !on }, async () => {
  const traceId = randomBytes(16).toString('hex');
  const parent = randomBytes(8).toString('hex');
  const r = await fetch(`${LITELLM}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-filter-it-not-a-secret', traceparent: `00-${traceId}-${parent}-01` },
    body: JSON.stringify({ model: 'sovereign-default', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(r.status, 200, await r.text());
  let mine = [];
  for (let i = 0; i < 30 && !mine.some((s) => s.parentSpanId === parent); i++) {
    await sleep(1_000);
    mine = spans().filter((s) => s.traceId === traceId);
  }
  console.log(`generation trace ${traceId}: ${mine.length} span(s): ${mine.map((s) => s.name).join(', ')}`);
  assert.ok(mine.length > 0, 'no span of the generation reached the sink');
  assert.ok(mine.some((s) => s.parentSpanId === parent), 'no span is a child of the caller\'s span');
  assert.ok(mine.every((s) => s.parentSpanId), 'a span of a traced call has no parent');
  assert.ok(mine.some((s) => /chat|completion|generation|sovereign-default/i.test(s.name)), `no generation span: ${mine.map((s) => s.name).join(', ')}`);
});

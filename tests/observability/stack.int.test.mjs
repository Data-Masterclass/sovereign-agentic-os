/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-05 — the observability stack proven on the real components (design 00 §6).
 * USER STORY: As an operator I want metrics, logs and OPA decision logs to land in VictoriaMetrics
 *             and VictoriaLogs through the OpenTelemetry Collector, and to see that by querying
 *             those stores' own APIs — not by trusting a config file.
 * ARCHITECTURE:
 *   - Runs against tests/observability/kind-up.sh: the chart's rendered Collector, VictoriaMetrics,
 *     VictoriaLogs and OPA on a kind cluster, port-forwarded to 127.0.0.1.
 *   - OTLP in: OTLP/JSON over HTTP to the Collector (the protocol every OS emitter uses).
 *   - Out: VictoriaMetrics `/api/v1/query` (PromQL), VictoriaLogs `/select/logsql/query` (LogsQL).
 *   - OPA: one real decision (`POST /v1/data/...`); its `decision_id` must come back from
 *     VictoriaLogs — the console → file_log → VictoriaLogs path of 00 Reconciliation #5.
 *   - Negative twins: an id OPA never issued is NOT found (the query really discriminates), and a
 *     metric name nobody sent is NOT found.
 *   - Run: node --test tests/observability/stack.int.test.mjs (OBS_IT=1 required).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const on = process.env.OBS_IT === '1';
const COLLECTOR = process.env.OBS_COLLECTOR_URL ?? 'http://127.0.0.1:14318';
const VM = process.env.OBS_VM_URL ?? 'http://127.0.0.1:18428';
const VL = process.env.OBS_VL_URL ?? 'http://127.0.0.1:19428';
const OPA = process.env.OBS_OPA_URL ?? 'http://127.0.0.1:18181';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  assert.ok(r.ok, `${url} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function promql(q) {
  const r = await fetch(`${VM}/api/v1/query?query=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()).data.result;
}
async function logsql(q, start = '15m') {
  const r = await fetch(`${VL}/select/logsql/query?query=${encodeURIComponent(q)}&start=${start === '15m' ? new Date(Date.now() - 15 * 60_000).toISOString() : start}`);
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function until(fn, ms = 60_000, step = 2_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last && (!Array.isArray(last) || last.length)) return last; await sleep(step); }
  return last;
}
const nowNs = () => String(BigInt(Date.now()) * 1_000_000n);
const resource = (svc) => ({ attributes: [{ key: 'service.name', value: { stringValue: svc } }] });

test('OTLP metric through the Collector is stored in VictoriaMetrics (PromQL)', { skip: !on }, async () => {
  const name = `wp05_it_gauge_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  await post(`${COLLECTOR}/v1/metrics`, {
    resourceMetrics: [{ resource: resource('wp05-it'), scopeMetrics: [{ scope: { name: 'wp05' }, metrics: [{ name, gauge: { dataPoints: [{ asDouble: 42.5, timeUnixNano: nowNs() }] } }] }] }],
  });
  const res = await until(() => promql(name));
  assert.equal(res.length, 1, `metric ${name} not in VictoriaMetrics`);
  assert.equal(Number(res[0].value[1]), 42.5);
  // Negative twin: a name nobody sent is not there (the query discriminates).
  assert.deepEqual(await promql(`${name}_never_sent`), []);
});

test('OTLP log through the Collector is stored in VictoriaLogs (LogsQL)', { skip: !on }, async () => {
  const marker = `wp05-it-log-${randomUUID()}`;
  await post(`${COLLECTOR}/v1/logs`, {
    resourceLogs: [{ resource: resource('wp05-it'), scopeLogs: [{ scope: { name: 'wp05' }, logRecords: [{ timeUnixNano: nowNs(), severityText: 'INFO', body: { stringValue: marker }, attributes: [{ key: 'trace_id', value: { stringValue: 'abc123' } }] }] }] }],
  });
  const rows = await until(() => logsql(`"${marker}"`));
  assert.equal(rows.length, 1, `log ${marker} not in VictoriaLogs`);
  assert.equal(rows[0]._msg, marker);
  assert.equal(rows[0]['service.name'], 'wp05-it');
  assert.deepEqual(await logsql(`"${marker}-never-sent"`), []);
});

test('the kubelet_stats receiver puts real pod CPU and memory into VictoriaMetrics', { skip: !on }, async () => {
  const res = await until(() => promql('k8s_pod_memory_working_set_bytes{k8s_pod_name=~"opa-.*"}'), 120_000, 5_000);
  assert.ok(res.length >= 1, 'no k8s_pod_memory_working_set_bytes series for the OPA pod');
  // A series per container / pod incarnation; at least one carries the running OPA's real memory.
  assert.ok(res.some((r) => Number(r.value[1]) > 0), `every series is 0: ${JSON.stringify(res.map((r) => [r.metric, r.value[1]]))}`);
  const cpu = await until(() => promql('k8s_pod_cpu_usage{k8s_pod_name=~"opa-.*"}'), 120_000, 5_000);
  assert.ok(cpu.length >= 1, 'no k8s_pod_cpu_usage series for the OPA pod');
});

test('an OPA decision appears in VictoriaLogs with its decision_id (console -> file_log -> VictoriaLogs)', { skip: !on }, async () => {
  const principal = `wp05-it-${randomUUID().slice(0, 8)}`;
  const out = await post(`${OPA}/v1/data/agentic/authz/decision`, { input: { principal, tool: 'rag_search' } });
  assert.ok(out.decision_id, `OPA returned no decision_id: ${JSON.stringify(out)}`);
  const rows = await until(() => logsql(`decision_id:"${out.decision_id}"`), 90_000);
  assert.equal(rows.length, 1, `decision ${out.decision_id} not in VictoriaLogs`);
  const row = rows[0];
  assert.equal(row.msg, 'Decision Log');
  assert.equal(row['input.principal'], principal);
  assert.match(row['k8s.pod.name'] ?? '', /^opa-/);
  assert.ok(row['labels.policy_rev'], 'policy_rev label missing');
  // Negative twin: an id OPA never issued is not found.
  assert.deepEqual(await logsql(`decision_id:"${randomUUID()}"`), []);
});

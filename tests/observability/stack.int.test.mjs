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
  // The kubelet can report 0 for a pod it has just started measuring; wait for a real reading.
  const q = 'k8s_pod_memory_working_set_bytes{k8s_pod_name=~"opa-.*"}';
  const res = await until(async () => (await promql(q)).filter((r) => Number(r.value[1]) > 0), 180_000, 5_000);
  assert.ok(res.length >= 1, `no non-zero k8s_pod_memory_working_set_bytes for the OPA pod: ${JSON.stringify(await promql(q))}`);
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

// ---- WP-05 review: who may reach the stores, which logs are read, and what is masked ----------
import { execFileSync } from 'node:child_process';

const CTX = process.env.KUBE_CONTEXT ?? 'kind-wp05';
const NS = process.env.OBS_NS ?? 'obs-it';
const CURL = 'curlimages/curl:8.11.1';
const kc = (...a) => execFileSync('kubectl', ['--context', CTX, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** A long-running pod with the given component label; returns its name. */
function pod(name, component, ns = NS, image = CURL, command = ['sleep', '3600']) {
  kc('-n', ns, 'delete', 'pod', name, '--ignore-not-found', '--wait=true');
  kc('-n', ns, 'run', name, `--image=${image}`, `--labels=app.kubernetes.io/component=${component}`, '--restart=Never', '--command', '--', ...command);
  kc('-n', ns, 'wait', '--for=condition=Ready', `pod/${name}`, '--timeout=180s');
  return name;
}
/** HTTP status from inside a pod, or 'blocked' when the connection times out. */
function curlFrom(name, url, method = 'GET') {
  try {
    const body = method === 'POST' ? ['-H', 'content-type: application/json', '--data-binary', '{}'] : [];
    return kc('-n', NS, 'exec', name, '--', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5', '-X', method, ...body, url).trim();
  } catch (e) {
    // curl 28 = timed out (the policy drops), 7 = refused (the policy rejects): both are blocked.
    return e.status === 28 || e.status === 7 || /exit code (28|7)\b/.test(String(e.message)) ? 'blocked' : `error ${e.status}: ${String(e.stderr).slice(0, 160)}`;
  }
}

test('ingress: os-ui may read the stores; any other pod (e.g. Dagster user code) can neither read nor write them', { skip: !on }, async () => {
  const os = pod('wp05-as-os-ui', 'os-ui');
  const intruder = pod('wp05-as-dagster-code', 'dagster-user-deployments');
  const VLs = 'http://victoria-logs:9428/select/logsql/query?query=*&limit=1';
  const VMs = 'http://victoria-metrics:8428/api/v1/query?query=up';
  assert.equal(curlFrom(os, VLs), '200', 'os-ui cannot read VictoriaLogs');
  assert.equal(curlFrom(os, VMs), '200', 'os-ui cannot read VictoriaMetrics');
  assert.equal(curlFrom(os, 'http://otel-collector:13133/'), '200', 'os-ui cannot reach the Collector health');
  // Negative twins: the same requests from a pod that is not the OS.
  assert.equal(curlFrom(intruder, VLs), 'blocked', 'a non-OS pod read VictoriaLogs');
  assert.equal(curlFrom(intruder, VMs), 'blocked', 'a non-OS pod read VictoriaMetrics');
  assert.equal(curlFrom(intruder, 'http://victoria-logs:9428/insert/jsonline', 'POST'), 'blocked', 'a non-OS pod could write VictoriaLogs');
  assert.equal(curlFrom(intruder, 'http://otel-collector:4318/v1/logs', 'POST'), 'blocked', 'a non-OS pod could post OTLP logs to the Collector');
});

test('file_log reads platform namespaces only, and masks secrets in what it stores', { skip: !on }, async () => {
  const marker = `wp05-scope-${randomUUID().slice(0, 8)}`;
  const line = JSON.stringify({ msg: marker, password: 'hunter2-real-secret', note: `call with Authorization: Bearer abcdefghijklmnop0123 and key sk-litellm-abcdefgh12345678 db postgres://app:s3cr3tpw@pg-rw:5432/x`, usage: { total_tokens: 42 } });
  try { kc('create', 'namespace', 'wp05-apps'); } catch { /* exists */ }
  const echo = ['sh', '-c', `while true; do echo '${line}'; sleep 5; done`];
  pod('wp05-leaky', 'wp05-leaky', NS, 'busybox:1.37', echo);
  pod('wp05-user-app', 'user-app', 'wp05-apps', 'busybox:1.37', ['sh', '-c', `while true; do echo '${JSON.stringify({ msg: `${marker}-userapp` })}'; sleep 5; done`]);
  const rows = await until(() => logsql(`"${marker}" k8s.pod.name:"wp05-leaky"`), 90_000);
  assert.ok(rows.length >= 1, `the platform pod's line ${marker} is not in VictoriaLogs`);
  const stored = JSON.stringify(rows[0]);
  for (const secret of ['hunter2-real-secret', 'abcdefghijklmnop0123', 'sk-litellm-abcdefgh12345678', 's3cr3tpw']) assert.ok(!stored.includes(secret), `secret ${secret} reached VictoriaLogs: ${stored}`);
  assert.equal(rows[0].password, undefined, 'a field named password was stored');
  assert.match(rows[0].note, /Authorization: \*\*\*.*sk-\*\*\*.*postgres:\/\/app:\*\*\*@pg-rw/);
  assert.equal(String(rows[0]['usage.total_tokens']), '42', 'a token COUNT was masked as if it were a secret');
  // Negative twin: the same kind of line from a non-platform namespace never arrives.
  await sleep(15_000);
  assert.deepEqual(await logsql(`"${marker}-userapp"`), [], 'a user-app namespace log reached VictoriaLogs');
  kc('delete', 'namespace', 'wp05-apps', '--wait=false');
});

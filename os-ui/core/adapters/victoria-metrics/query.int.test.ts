/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The PromQL and LogsQL readers on the REAL VictoriaMetrics and VictoriaLogs (chart pins).
 * USER STORY: As an operator I want resource pressure and error-log rates on the Monitoring tab to be
 *             what VictoriaMetrics and VictoriaLogs answer, not numbers the OS made up.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh starts both on the images values.yaml pins. Series go in through
 *     VictoriaMetrics' documented `/api/v1/import/prometheus`, log lines through VictoriaLogs'
 *     `/insert/jsonline`; the readers query `/api/v1/query` and `/select/logsql/query`.
 *   - Negative twins: a series / a line nobody sent is not returned (the query discriminates), and a
 *     stopped port answers ok:false `unreachable`, never an empty success.
 *   - Run: MON_IT=1 node --import ./scripts/test-setup.mjs --test core/adapters/victoria-metrics/query.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promInstant } from './query';
import { logsQuery } from '../victoria-logs/query';

const on = process.env.MON_IT === '1';
const VM = process.env.MON_VM_URL ?? 'http://127.0.0.1:18529';
const VL = process.env.MON_VL_URL ?? 'http://127.0.0.1:19529';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T[]>, ms = 30_000): Promise<T[]> {
  const end = Date.now() + ms;
  let last: T[] = [];
  while (Date.now() < end) {
    last = await fn();
    if (last.length) return last;
    await sleep(1000);
  }
  return last;
}

test('promInstant returns the samples VictoriaMetrics holds, with labels and numeric values', { skip: !on }, async () => {
  const name = `mon_it_mem_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const body = `${name}{k8s_pod_name="opa-1"} 300\n${name}{k8s_pod_name="trino-0"} 900\n`;
  const r = await fetch(`${VM}/api/v1/import/prometheus`, { method: 'POST', body });
  assert.equal(r.status, 204);
  const res = await until(async () => {
    const q = await promInstant(`topk(1, ${name})`, { base: VM });
    assert.ok(q.ok, JSON.stringify(q));
    return q.ok ? q.value : [];
  });
  assert.equal(res.length, 1);
  assert.equal(res[0].metric.k8s_pod_name, 'trino-0');
  assert.equal(res[0].value, 900);
  // Negative twin: a name nobody sent is an empty answer, not a match.
  const none = await promInstant(`${name}_never_sent`, { base: VM });
  assert.ok(none.ok);
  assert.deepEqual(none.value, []);
});

test('promInstant reports a PromQL error and an unreachable store as failures, never as no data', { skip: !on }, async () => {
  const bad = await promInstant('sum(', { base: VM });
  assert.equal(bad.ok, false);
  const down = await promInstant('up', { base: 'http://127.0.0.1:1' });
  assert.equal(down.ok, false);
  assert.equal(!down.ok && down.reason, 'unreachable');
});

test('logsQuery returns VictoriaLogs rows and stats; a line nobody sent is not found', { skip: !on }, async () => {
  const marker = `mon-it-${randomUUID().slice(0, 8)}`;
  const lines = [
    { _msg: 'Decision Log', msg: 'Decision Log', marker, path: 'agentic/authz/decision', 'input.principal': 'os-sysA', 'result.effect': 'deny' },
    { _msg: 'Decision Log', msg: 'Decision Log', marker, path: 'agentic/authz/decision', 'input.principal': 'os-sysA:writer', 'result.effect': 'deny' },
    { _msg: 'Decision Log', msg: 'Decision Log', marker, path: 'agentic/authz/decision', 'input.principal': 'os-sysB', 'result.effect': 'allow' },
  ].map((l) => JSON.stringify({ ...l, _time: new Date().toISOString() })).join('\n');
  const r = await fetch(`${VL}/insert/jsonline`, { method: 'POST', body: lines });
  assert.equal(r.status, 200);
  const rows = await until(async () => {
    const q = await logsQuery(`marker:"${marker}" input.principal:~"^os-sysA(:|$)" | stats by (result.effect) count() as n`, { base: VL, start: '1h' });
    assert.ok(q.ok, JSON.stringify(q));
    return q.ok ? q.value : [];
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['result.effect'], 'deny');
  assert.equal(rows[0].n, '2');
  const none = await logsQuery(`marker:"${marker}-never-sent"`, { base: VL, start: '1h' });
  assert.ok(none.ok);
  assert.deepEqual(none.value, []);
  const down = await logsQuery('*', { base: 'http://127.0.0.1:1', start: '1h' });
  assert.equal(down.ok, false);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring panels' exact PromQL and LogsQL (panels-core.ts) on the REAL
 *             VictoriaMetrics and VictoriaLogs (chart pins).
 * USER STORY: As an operator I want the OPA-denial counts, error-log rates and node pressure on the
 *             Monitoring tab to be what the stores answer for the queries the panels send.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh; fixtures through `/insert/jsonline` and `/api/v1/import/prometheus`,
 *     shaped like the Collector's output (OPA decision-log fields, kubelet_stats names).
 *   - Negative twins: a look-alike principal (`os-<id>x`) and another OPA path are not counted.
 *   - Run: MON_IT=1 node --import ./scripts/test-setup.mjs --test tabs/monitoring/lib/panels/panels-queries.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promInstant } from '@core/adapters/victoria-metrics/query';
import { logsQuery } from '@core/adapters/victoria-logs/query';
import { ERROR_LOG_QUERY, PROMQL, errorLogRows, foldDecisions, nodePressure, opaDecisionQuery } from '@tabs/monitoring/lib/panels/panels-core';

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


test('the Agents panel OPA query counts an asked system’s denials and holds, never another system’s', { skip: !on }, async () => {
  const sys = `sysq${randomUUID().slice(0, 6)}`;
  const row = (principal: string, effect: string, tool = 'crm_write') => ({ _msg: 'Decision Log', msg: 'Decision Log', path: 'agentic/authz/decision', 'input.principal': principal, 'input.tool': tool, 'result.effect': effect, _time: new Date().toISOString() });
  const lines = [row(`os-${sys}`, 'deny'), row(`os-${sys}:writer`, 'deny'), row(`os-${sys}`, 'requires_approval', 'publish'), row(`os-${sys}x`, 'deny'), row(`os-${sys}`, 'deny', 'x')]
    .map((l, i) => JSON.stringify(i === 4 ? { ...l, path: 'os/guardrails/decision' } : l)).join('\n');
  assert.equal((await fetch(`${VL}/insert/jsonline`, { method: 'POST', body: lines })).status, 200);
  const rows = await until(async () => {
    const q = await logsQuery(opaDecisionQuery([sys], '1h'), { base: VL });
    assert.ok(q.ok, JSON.stringify(q));
    return q.ok && q.value.reduce((n, r) => n + Number(r.n), 0) >= 3 ? q.value : [];
  });
  const c = foldDecisions(rows, [sys]).get(sys);
  assert.ok(c, JSON.stringify(rows));
  assert.equal(c.denies, 2, 'os-<id>x and the guardrails path must not count');
  assert.equal(c.held, 1);
});

test('the Platform panel error-log query and node-pressure PromQL answer from the real stores', { skip: !on }, async () => {
  const ns = `mon-ns-${randomUUID().slice(0, 6)}`;
  const lines = [
    { _msg: 'ERROR connection refused', 'k8s.namespace.name': ns, 'k8s.container.name': 'trino' },
    { _msg: 'an Error happened', 'k8s.namespace.name': ns, 'k8s.container.name': 'trino' },
    { _msg: 'all good', 'k8s.namespace.name': ns, 'k8s.container.name': 'trino' },
  ].map((l) => JSON.stringify({ ...l, _time: new Date().toISOString() })).join('\n');
  assert.equal((await fetch(`${VL}/insert/jsonline`, { method: 'POST', body: lines })).status, 200);
  const rows = await until(async () => {
    const q = await logsQuery(ERROR_LOG_QUERY.replace('_time:1h', `_time:1h k8s.namespace.name:"${ns}"`), { base: VL });
    assert.ok(q.ok, JSON.stringify(q));
    return q.ok ? q.value : [];
  });
  assert.deepEqual(errorLogRows(rows), [{ namespace: ns, container: 'trino', errors: 2 }]);

  const node = `mon-node-${randomUUID().slice(0, 6)}`;
  const body = [`k8s_node_memory_working_set_bytes{k8s_node_name="${node}"} 600`, `k8s_node_memory_available_bytes{k8s_node_name="${node}"} 400`, `k8s_node_filesystem_usage_bytes{k8s_node_name="${node}"} 25`, `k8s_node_filesystem_capacity_bytes{k8s_node_name="${node}"} 100`].join('\n');
  assert.equal((await fetch(`${VM}/api/v1/import/prometheus`, { method: 'POST', body })).status, 204);
  const mem = await until(async () => {
    const q = await promInstant(PROMQL.nodeMemory, { base: VM });
    return q.ok ? q.value.filter((s) => s.metric.k8s_node_name === node) : [];
  });
  const disk = await promInstant(PROMQL.nodeDisk, { base: VM });
  assert.ok(disk.ok);
  const p = nodePressure(mem, disk.value.filter((s) => s.metric.k8s_node_name === node));
  assert.deepEqual(p, [{ node, memory: 0.6, disk: 0.25 }]);
});

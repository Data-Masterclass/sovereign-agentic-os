/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring panels' pure folds — exact queries, and no row for an unasked id.
 * USER STORY: As a reviewer I want proof that an upstream answer about another system cannot reach
 *             the panel payload, and that the queries are the documented ones.
 * ARCHITECTURE: pure unit tests over panels-core.ts; the upstream reads have their own
 *   real-container tests (query.int.test.ts, metrics.int.test.ts, run-stats.int.test.ts, monitoring-read.int.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorLogRows, foldDecisions, keySpendBySystem, nodePressure, opaDecisionQuery, qualityTrend, systemOfPrincipal, systemPrincipalRegex } from './panels-core';

test('the OPA principal regex matches os-<id> and os-<id>:<node> only, with ids escaped', () => {
  const re = new RegExp(systemPrincipalRegex(['sys_a', 'b.c']));
  assert.ok(re.test('os-sys_a'));
  assert.ok(re.test('os-sys_a:writer'));
  assert.ok(re.test('os-b.c'));
  assert.ok(!re.test('os-bxc'), 'a dot in an id is literal');
  assert.ok(!re.test('os-sys_ab'));
  assert.ok(!re.test('xos-sys_a'));
  assert.match(opaDecisionQuery(['sys_a']), /^_time:7d msg:"Decision Log" path:"agentic\/authz\/decision" input\.principal:~"\^os-\(sys_a\)\(:\|\$\)" \| stats by/);
});

test('decisions fold per system by OPA effect; an unasked principal is dropped', () => {
  const rows = [
    { 'input.principal': 'os-a', 'input.tool': 'crm_write', 'result.effect': 'deny', n: '3' },
    { 'input.principal': 'os-a:writer', 'input.tool': 'crm_write', 'result.effect': 'deny', n: '2' },
    { 'input.principal': 'os-a', 'input.tool': 'publish', 'result.effect': 'requires_approval', n: '1' },
    { 'input.principal': 'os-other', 'input.tool': 'x', 'result.effect': 'deny', n: '99' },
  ];
  const m = foldDecisions(rows, ['a']);
  assert.deepEqual([...m.keys()], ['a']);
  assert.equal(m.get('a')!.denies, 5);
  assert.equal(m.get('a')!.held, 1);
  assert.deepEqual(m.get('a')!.byTool[0], { tool: 'crm_write', effect: 'deny', n: 5 });
  assert.equal(systemOfPrincipal('os-other', new Set(['a'])), null);
});

test('key spend is read by alias os-<id>, for asked systems only', () => {
  const m = keySpendBySystem([{ key_alias: 'os-a', spend: 1.5 }, { key_alias: 'os-b', spend: 9 }, { key_alias: 'sovereign-agents', spend: 4 }, { key_alias: null, spend: 1 }], ['a']);
  assert.deepEqual([...m.entries()], [['a', 1.5]]);
});

test('node pressure joins memory and disk by node; error rows keep VictoriaLogs counts', () => {
  const p = nodePressure([{ metric: { k8s_node_name: 'n1' }, value: 0.8 }], [{ metric: { k8s_node_name: 'n1' }, value: 0.4 }, { metric: { k8s_node_name: 'n2' }, value: 0.1 }]);
  assert.deepEqual(p, [{ node: 'n1', memory: 0.8, disk: 0.4 }, { node: 'n2', memory: null, disk: 0.1 }]);
  assert.deepEqual(errorLogRows([{ 'k8s.namespace.name': 'agentic-os', 'k8s.container.name': 'os-ui', errors: '12' }]), [{ namespace: 'agentic-os', container: 'os-ui', errors: 12 }]);
});

test('the quality trend is one point per Dagster run, oldest first; unevaluated executions do not count', () => {
  const t = qualityTrend([
    { runId: 'r2', at: '2026-11-21T10:00:00Z', passed: false },
    { runId: 'r2', at: '2026-11-21T10:00:00Z', passed: true },
    { runId: 'r1', at: '2026-11-20T10:00:00Z', passed: true },
    { runId: 'r3', at: '2026-11-21T11:00:00Z', passed: null },
  ]);
  assert.deepEqual(t, [
    { runId: 'r1', at: '2026-11-20T10:00:00Z', passed: 1, total: 1 },
    { runId: 'r2', at: '2026-11-21T10:00:00Z', passed: 1, total: 2 },
  ]);
});

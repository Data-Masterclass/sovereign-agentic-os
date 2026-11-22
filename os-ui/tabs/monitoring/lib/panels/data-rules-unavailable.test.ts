/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Data never presents a recorded value as live when Dagster cannot be asked.
 * USER STORY: As a data engineer I want a rule whose Dagster executions could not be read to say
 *             "unavailable" with the reason (and the last recorded value labelled with its time),
 *             not to show the recorded status as if Dagster had just answered.
 * ARCHITECTURE: checkExecutions is a recorder that fails for one rule (real-container proof of the read:
 *   core/adapters/dagster/monitoring-read.int.test.ts). Negative twin: with every read answering, no rule is
 *   unavailable and sources.tests stays live. Hidden downstream consumers are only counted.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
const at = (d: number) => `2026-11-${String(d).padStart(2, '0')}T03:00:00.000Z`;
let failFor: string | null = null;

mock.module('@core/infra/dagster', { namedExports: { ...(await real('@core/infra/dagster')), recentOsRuns: async () => ({ ok: true, data: [] }) } });
mock.module('@core/adapters/dagster/monitoring-read', {
  namedExports: {
    ...(await real('@core/adapters/dagster/monitoring-read')),
    // the dataset's own asset is downstream-linked to two assets of another domain
    dependedByGraph: async () => ({ ok: true, value: new Map([['sales/orders', [['hr', 'salary_by_order'], ['finance', 'rev'], ['finance', 'rev2']]]]), at: '' }),
    checkExecutions: async (_key: string[], name: string) => {
      if (name === failFor) return { ok: false, reason: 'unreachable', detail: 'Dagster did not answer', at: '' };
      return { ok: true, at: '', value: [{ runId: 'run_3', at: at(14), passed: true, status: 'SUCCEEDED', severity: null, failedRows: null }] };
    },
  },
});

const { registerMonitoringSources } = await import('./sources');
const { dataView } = await import('./data-panel');
registerMonitoringSources({
  agentSystems: async () => [],
  datasets: async () => [{ id: 'orders', name: 'Orders', domain: 'sales', scope: 'mine' }],
  latestTests: async () => new Map([['orders', { source: 'dagster' as const, ranAt: at(10), results: [
    { id: 'not_null_orders_id', label: 'not_null_orders_id', status: 'fail', violations: 7 },
    { id: 'unique_orders_id', label: 'unique_orders_id', status: 'pass', violations: null }] }]]),
  assetKeys: async () => new Map([['orders', { tested: ['sales', 'orders'], models: [['sales', 'orders']] }]]),
});
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;

test('a rule whose Dagster read failed is unavailable with the reason; the recorded value is labelled with its time', async () => {
  failFor = 'not_null_orders_id';
  const v = await dataView(ada);
  const nn = v.datasets[0].rules!.find((r) => r.name === 'not_null_orders_id')!;
  assert.equal(nn.status, 'unavailable', 'never the recorded "fail" presented as the live status');
  assert.match(nn.unavailableReason!, /Dagster did not answer/);
  assert.deepEqual(nn.lastRecorded, { status: 'fail', failingRows: 7, at: at(10) });
  assert.equal('failingRows' in nn, false, 'no recorded row count shown as the current one');
  assert.equal('lastRunAt' in nn, false);
  assert.equal(v.sources.tests.state, 'unavailable');
  assert.match((v.sources.tests as { reason: string }).reason, /Dagster/);
  assert.equal('trend' in v.datasets[0] && v.datasets[0].trend !== undefined, false, 'a partial trend is not presented as the whole');
  // the other rule was read fine and stays live
  const un = v.datasets[0].rules!.find((r) => r.name === 'unique_orders_id')!;
  assert.equal(un.status, 'pass');
  assert.equal(un.unavailableReason, undefined);
});

test('negative twin: when every read answers nothing is unavailable and sources.tests is live', async () => {
  failFor = null;
  const v = await dataView(ada);
  assert.ok(v.datasets[0].rules!.every((r) => r.status !== 'unavailable' && !('lastRecorded' in r)));
  assert.equal(v.sources.tests.state, 'live');
  assert.ok(v.datasets[0].trend);
});

test('hidden downstream consumers are only counted; no other domain’s name or count survives', async () => {
  failFor = null;
  const v = await dataView(ada);
  const h = v.datasets[0].downstreamHidden!;
  assert.deepEqual(h, { count: 3 });
  const json = JSON.stringify(v);
  assert.ok(!/\bhr\b|finance|salary_by_order|rev2/.test(json), 'no other domain’s name reaches the viewer');
});

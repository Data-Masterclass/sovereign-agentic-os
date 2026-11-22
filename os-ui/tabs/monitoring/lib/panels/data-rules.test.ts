/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Data shows data quality per rule and per dataset, from Dagster's asset checks.
 * USER STORY: As a data engineer I want each dbt test of my datasets with its type, status (pass / fail /
 *             warn), failing rows, last run, failing-since, severity, Dagster run link and trend — and
 *             only for the datasets I may see.
 * ARCHITECTURE: the Dagster reads are replaced by recorders (their real-container proofs are
 *   core/adapters/dagster/monitoring-read.int.test.ts); what is tested is the glue: which datasets' checks
 *   are asked for, the rule fields, and that an unasked dataset's rule never reaches the payload.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
const askedChecks: string[] = [];
const at = (d: number) => `2026-11-${String(d).padStart(2, '0')}T03:00:00.000Z`;

mock.module('@core/infra/dagster', { namedExports: { ...(await real('@core/infra/dagster')), recentOsRuns: async () => ({ ok: true, data: [] }) } });
mock.module('@core/adapters/dagster/monitoring-read', {
  namedExports: {
    ...(await real('@core/adapters/dagster/monitoring-read')),
    dependedByGraph: async () => ({ ok: true, value: new Map(), at: '' }),
    checkExecutions: async (key: string[], name: string) => {
      askedChecks.push(`${key.join('/')}:${name}`);
      if (name === 'not_null_orders_id') return { ok: true, at: '', value: [
        { runId: 'run_3', at: at(14), passed: false, status: 'FAILED', severity: 'ERROR', failedRows: 3 },
        { runId: 'run_2', at: at(13), passed: false, status: 'FAILED', severity: 'ERROR', failedRows: 2 },
        { runId: 'run_1', at: at(12), passed: true, status: 'SUCCEEDED', severity: null, failedRows: null }] };
      if (name === 'accepted_values_orders_status__a__b') return { ok: true, at: '', value: [{ runId: 'run_3', at: at(14), passed: false, status: 'FAILED', severity: 'WARN', failedRows: null }] };
      return { ok: true, at: '', value: [{ runId: 'run_3', at: at(14), passed: true, status: 'SUCCEEDED', severity: null, failedRows: null }] };
    },
  },
});

const { registerMonitoringSources } = await import('./sources');
const { dataView } = await import('./data-panel');
const results = (names: string[]) => names.map((n) => ({ id: n, label: n, status: 'fail', violations: null }));
registerMonitoringSources({
  agentSystems: async () => [],
  // ada sees `orders` only; `hr_secret` exists in the store but is not in her scoped list.
  datasets: async (p) => (p.id === 'ada' ? [{ id: 'orders', name: 'Orders', domain: 'sales', scope: 'mine' }] : [{ id: 'orders', name: 'Orders', domain: 'sales', scope: 'domain' }, { id: 'hr_secret', name: 'Salaries', domain: 'hr', scope: 'domain' }]),
  latestTests: async (ds) => new Map(ds.map((d) => [d.id, { source: 'dagster' as const, ranAt: at(14), results: d.id === 'orders' ? results(['not_null_orders_id', 'unique_orders_id', 'accepted_values_orders_status__a__b']) : results(['not_null_salaries_id']) }])),
  assetKeys: async (ds) => new Map(ds.map((d) => [d.id, { tested: [d.domain, d.id], models: [[d.domain, d.id]] }])),
});

const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;

test('each rule carries type, status, failing rows, severity, last run, since, run link and trend', async () => {
  const v = await dataView(ada);
  const rules = v.datasets[0].rules!;
  const nn = rules.find((r) => r.name === 'not_null_orders_id')!;
  assert.equal(nn.type, 'not_null');
  assert.equal(nn.status, 'fail');
  assert.equal(nn.failingRows, 3);
  assert.equal(nn.severity, 'error');
  assert.equal(nn.lastRunAt, at(14));
  assert.equal(nn.failingSince, at(13), 'run_2 is the first failure of the streak that ends at run_3');
  assert.equal(nn.failingSinceExact, true);
  assert.deepEqual(nn.trend!.map((p) => [p.runId, p.passed]), [['run_1', true], ['run_2', false], ['run_3', false]]);
  const av = rules.find((r) => r.type === 'accepted_values')!;
  assert.equal(av.status, 'warn', 'a failed WARN-severity check is a warning');
  assert.equal('failingRows' in av, false, 'dbt reported no count: absent, never 0');
  const un = rules.find((r) => r.type === 'unique')!;
  assert.equal(un.status, 'pass');
  assert.equal('failingSince' in un, false);
});

test('only the viewer’s datasets are asked for; another dataset’s rule never reaches a creator', async () => {
  askedChecks.length = 0;
  const v = await dataView(ada);
  assert.ok(askedChecks.every((c) => c.startsWith('sales/orders:')), askedChecks.join());
  assert.ok(!JSON.stringify(v).includes('salaries') && !JSON.stringify(v).includes('hr_secret'));
});

test('an admin sees the rules of every dataset in the scoped list', async () => {
  const v = await dataView(admin);
  assert.deepEqual(v.datasets.map((d) => d.id).sort(), ['hr_secret', 'orders']);
  assert.ok(v.datasets.find((d) => d.id === 'hr_secret')!.rules!.length === 1);
});

test('the MCP door returns the same rules', async () => {
  const { MONITORING_TOOLS } = await import('@core/mcp/monitoring-tools');
  const tool = MONITORING_TOOLS.find((t) => t.name === 'get_monitoring_panels')!;
  const v = (await tool.call(ada, { view: 'data' })) as Awaited<ReturnType<typeof dataView>>;
  assert.equal(v.datasets[0].rules!.length, 3);
});

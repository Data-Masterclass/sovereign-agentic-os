/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The KPI engineering view — the dbt metric YAML as committed, and `mf query`
 * USER STORY: As a reviewer I want the dbt section of a KPI to show the `models/semantic/*.yml`
 *             that actually names this measure, and — while the semantic emitter has not landed —
 *             to say plainly that `mf query` would not resolve yet (checklist T1, T3, T7).
 * ARCHITECTURE:
 *   - Pure: the store and the repository reader are module-mocked; the real section builders and
 *     the real vocabulary rule run.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyViolations } from '@core/engineering/vocabulary';
import type { EngineeringPrincipal } from '@core/engineering/types';

const SEMANTIC = `semantic_models:
  - name: gold_orders
    measures:
      - name: revenue
        agg: sum
metrics:
  - name: revenue
    type: simple
    type_params: { measure: revenue }
`;

const RECORD = {
  id: 'ds_1.revenue',
  dataset: { id: 'ds_1', name: 'Orders', domain: 'ops' },
  measure: { name: 'revenue', label: 'Revenue', type: 'sum', sql: 'amount' },
  tier: 'domain',
  owner: 'amir',
  member: 'Orders.revenue',
};

let paths: string[] = ['models/semantic/gold_orders.yml'];
let files: { path: string; content: string }[] = [{ path: 'models/semantic/gold_orders.yml', content: SEMANTIC }];

mock.module('@tabs/metrics/lib/store', {
  namedExports: {
    getMetric: (id: string) => {
      if (id !== RECORD.id) { const e = new Error('Metric not found') as Error & { status?: number }; e.status = 404; throw e; }
      return RECORD;
    },
  },
});
mock.module('@core/engineering/repo', {
  namedExports: {
    repoPaths: async () => ({ repo: 'ops', head: 'cafe', paths, reason: null }),
    readRepoFiles: async () => ({ repo: 'ops', head: 'cafe', files, unreadable: [], reason: null }),
  },
});

const { metricEngineeringView, namesMeasure, SEMANTIC_DIR } = await import('@tabs/metrics/lib/engineering');
const USER = { id: 'amir', name: 'Amir', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'admin' } as unknown as EngineeringPrincipal;
const OUTSIDER = { id: 'fiona', name: 'Fiona', domains: ['finance'], allDomains: ['finance'], activeDomain: 'finance', role: 'admin' } as unknown as EngineeringPrincipal;

test('a semantic file is claimed only when it really names the measure', () => {
  assert.ok(namesMeasure(SEMANTIC, 'revenue'));
  assert.ok(!namesMeasure(SEMANTIC, 'margin'));
  assert.equal(SEMANTIC_DIR, 'models/semantic/');
});

test('T3: the dbt section shows the committed metrics YAML, the path and the MetricFlow query', async () => {
  const view = await metricEngineeringView(USER, RECORD.id);
  assert.deepEqual(vocabularyViolations(view), []);
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.equal(dbt?.artefacts[0].repoPath, 'models/semantic/gold_orders.yml');
  assert.equal(dbt?.artefacts[0].noun, 'dbt semantic model');
  assert.equal(dbt?.artefacts[0].body, SEMANTIC);
  assert.deepEqual(dbt?.commands.map((c) => c.command), [
    'dbt ls --select metric:revenue',
    'dbt build',
    'mf query --metrics revenue --group-by metric_time__month',
  ]);
  assert.equal(view.export?.href, '/api/data/projects/ops/export');
});

test('T7: with no semantic file committed, the section names the missing file and refuses to claim `mf query` works', async () => {
  paths = [];
  files = [];
  const view = await metricEngineeringView(USER, RECORD.id);
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.equal(dbt?.artefacts.length, 0);
  assert.match(dbt?.unavailable ?? '', /models\/semantic\/<model>\.yml/);
  assert.ok((dbt?.caveats ?? []).some((c) => /would not resolve/.test(c)));
  assert.deepEqual(vocabularyViolations(view), []);
  paths = ['models/semantic/gold_orders.yml'];
  files = [{ path: 'models/semantic/gold_orders.yml', content: SEMANTIC }];
});

test('T7: a KPI that does not exist is the tab\'s own 404', async () => {
  await assert.rejects(() => metricEngineeringView(USER, 'ds_1.missing'), (e: Error & { status?: number }) => e.status === 404);
});

test('H-1/M-1: a KPI on a data product in a domain the caller is not in shows no repository bytes and no export', async () => {
  const view = await metricEngineeringView(OUTSIDER, RECORD.id);
  assert.deepEqual(vocabularyViolations(view), []);
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.equal(dbt?.artefacts.length, 0);
  assert.match(dbt?.unavailable ?? '', /members-only/);
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /members-only/);
  // The member keeps everything.
  const inside = await metricEngineeringView(USER, RECORD.id);
  assert.equal(inside.export?.href, '/api/data/projects/ops/export');
  assert.equal(inside.export?.tool, 'dbt');
});

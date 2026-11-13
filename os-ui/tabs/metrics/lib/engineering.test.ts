/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The metric's engineering view speaks dbt's and Trino's vocabulary, and is honest
 * USER STORY: As a data engineer I want the Under-the-hood panel to name the tools' own objects and
 *             the commands I would run, and to SAY what the OS still does its own way — never a
 *             confident blank where a fact could not be resolved (checklist T1, T2).
 * ARCHITECTURE:
 *   - Pure. The adapter takes resolved facts, so this tests the structure and the words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineeringView, type MetricEngineeringInput } from '@tabs/metrics/lib/engineering';

const full: MetricEngineeringInput = {
  title: 'Revenue',
  member: 'Orders.revenue',
  metricType: 'simple',
  dbtMetricName: 'revenue',
  dbtSemanticModel: 'orders',
  dbtModel: 'gold_orders',
  yamlPath: 'models/semantic/orders.yml',
  yaml: "semantic_models:\n  - name: orders\n    model: ref('gold_orders')\n",
  domain: 'sales',
  headSha: 'a'.repeat(40),
  trinoSql: 'SELECT SUM(CAST(net_amount AS double)) AS "revenue"\nFROM iceberg.sales.gold_orders\nLIMIT 100',
  trinoPrincipal: 'amir',
  goldFqn: 'iceberg.sales.gold_orders',
  grain: 'day',
  spec: { dsiVersion: '0.8.5', dbtCore: '1.10' },
};

test('T2 vocabulary: every section is named for its TOOL, with the OS term in parentheses once', () => {
  const v = engineeringView('metric', 'ds_orders1.revenue', full);
  assert.deepEqual(v.sections.map((s) => s.tool), ['dbt', 'Trino', 'git']);
  assert.match(v.sections[0].label, /^dbt metric \(KPI\) — type: simple$/);
  assert.match(v.sections[1].label, /^Trino query/);
  for (const s of v.sections) {
    assert.doesNotMatch(s.label, /\bCube\b/);
    for (const f of s.facts) assert.ok(f.value.length > 0, `${s.tool}/${f.name} must not be an empty fact`);
  }
});

test('T1: the real artefact, the real SQL and the engineer`s commands are all present', () => {
  const v = engineeringView('metric', 'ds_orders1.revenue', full);
  const dbt = v.sections[0];
  assert.equal(dbt.artifact?.filename, 'models/semantic/orders.yml');
  assert.equal(dbt.artifact?.language, 'yaml');
  assert.equal(dbt.artifact?.body, full.yaml);
  assert.equal(dbt.command, 'mf query --metrics revenue --group-by metric_time__day');
  assert.deepEqual(
    dbt.facts.find((f) => f.name === 'spec'),
    { name: 'spec', value: 'dbt-semantic-interfaces 0.8.5 (dbt-core 1.10)' },
  );
  const trino = v.sections[1];
  assert.equal(trino.artifact?.body, full.trinoSql);
  assert.match(trino.command!, /^trino --execute 'SELECT /);
  assert.deepEqual(trino.facts.find((f) => f.name === 'principal'), { name: 'principal', value: 'amir' });
  const git = v.sections[2];
  assert.equal(git.command, 'git log --follow -p -- models/semantic/orders.yml');
  assert.deepEqual(git.facts.find((f) => f.name === 'commit trailer'), { name: 'commit trailer', value: 'OS-Object: metric:ds_orders1.revenue' });
});

test('honesty: a fact that could not be resolved is ABSENT and SAID, never a confident blank', () => {
  const v = engineeringView('metric', 'ds_orders1.revenue', { ...full, yaml: undefined, trinoSql: undefined, headSha: undefined });
  assert.equal(v.sections[0].artifact, undefined);
  assert.equal(v.sections[1].artifact, undefined);
  assert.equal(v.sections[1].command, undefined, 'no command is offered for SQL that was never run');
  assert.equal(v.sections[2].facts.some((f) => f.name === 'head'), false);
  const said = v.notTrueYet.join('\n');
  assert.match(said, /could not be read from the repository/);
  assert.match(said, /has not been read in this session yet/);
  assert.match(said, /head commit is not shown/);
});

test('honesty: the panel states that MetricFlow does not serve the number, and names the spine gap for a cumulative metric', () => {
  const simple = engineeringView('metric', 'ds_orders1.revenue', full);
  assert.match(simple.notTrueYet.join('\n'), /MetricFlow does not serve this number/);
  assert.equal(simple.notTrueYet.some((l) => /time spine/.test(l)), false);

  const cumulative = engineeringView('metric', 'ds_orders1.revenue_t7d', {
    ...full,
    metricType: 'cumulative',
    refusal: { code: 'window_grain_mismatch', reason: 'the slice granularity must be day' },
  });
  const said = cumulative.notTrueYet.join('\n');
  assert.match(said, /time spine .* is generated but the OS compiler does not join to it yet/);
  assert.match(said, /window_grain_mismatch/);
  assert.match(said, /the slice granularity must be day/);
});

test('the view is JSON-serialisable, so the MCP twin returns the identical structure', () => {
  const v = engineeringView('metric', 'ds_orders1.revenue', full);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
  assert.equal(v.kind, 'metric');
  assert.equal(v.id, 'ds_orders1.revenue');
  assert.equal(v.title, 'Revenue');
});

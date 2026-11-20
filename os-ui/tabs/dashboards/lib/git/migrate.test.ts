/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 dry-run migration plan — the live dashboard's shape, planned, never written
 * USER STORY: As the owner I want the plan for the live dashboard to say which panels become dbt
 *             saved queries and which stay pending, and why, before the flag is turned on.
 * ARCHITECTURE:
 *   - Pure. The input is the live `campaign-performance` file shape (one bar panel whose metric has
 *     no dbt YAML yet), plus a variant where the dbt metric exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planNativeMigration } from '@tabs/dashboards/lib/git/migrate';

const V = 'sales__Orders';
const legacy = (member: string) => `apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: campaign-performance-ye3fv2
  name: Campaign performance
  domain: sales
  owner: f6da0379dc3f
  tier: personal
  folder: '/'
spec:
  view: ${V}
  sources:
    - ref: unresolved
      member: ${member}
  panels:
    - id: p_campaign-performance
      name: Campaign Performance
      viz: bar
      metrics: [${member}]
      dimensions: [${V}.region]
      gridPos: { x: 0, y: 0, w: 12, h: 1 }
`;
const golden = JSON.parse(readFileSync(new URL('../../../data/lib/dbt/fixtures/metrics-semantic-layer.golden.json', import.meta.url), 'utf8')) as Record<string, string>;
const OLD = 'dashboards/personal/f6da0379dc3f/campaign-performance/dashboard.yaml';

test('the live shape (metric not in dbt yet) plans a PENDING panel and deletes the old file', () => {
  const plan = planNativeMigration('sales', new Map([...Object.entries(golden), [OLD, legacy(`${V}.new_customers`)]]));
  assert.equal(plan.dashboards.length, 1);
  assert.match(plan.dashboards[0].panels[0].pending ?? '', /new_customers has no dbt metric/);
  assert.deepEqual(plan.delete, [OLD]);
  assert.ok(plan.add.includes('dashboards/personal/f6da0379dc3f/campaign-performance/semantic.yml'));
  assert.ok(plan.add.includes('dashboards/personal/f6da0379dc3f/campaign-performance/panels/p_campaign-performance.vl.json'));
});

test('once the metric exists in dbt, the same panel plans as a saved query', () => {
  const plan = planNativeMigration('sales', new Map([...Object.entries(golden), [OLD, legacy(`${V}.revenue`)]]));
  assert.equal(plan.dashboards[0].panels[0].savedQuery, 'personal_f6da0379dc3f_campaign_performance_campaign_performance');
});

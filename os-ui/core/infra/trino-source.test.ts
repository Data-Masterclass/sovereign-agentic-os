/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino scheduling identity tests
 * USER STORY: As a maintainer I want the os-ui source to match the chart's resource-group selector exactly.
 * ARCHITECTURE:
 * - Pure node:test; reads the selector regex from charts/sovereign-agentic-os/values.yaml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeDomain, routeFor, trinoClientTags, trinoSource } from '@core/infra/trino-source';

test('source is os-ui/<sanitised domain>/<surface>', () => {
  assert.equal(trinoSource({ domain: 'sales', surface: 'data-query' }), 'os-ui/sales/data-query');
  assert.equal(trinoSource({ domain: 'agentic-leader-q3-2026', surface: 'metrics' }), 'os-ui/agentic_leader_q3_2026/metrics');
  assert.equal(routeDomain(''), '-');
  assert.equal(routeDomain(undefined), '-');
  assert.throws(() => trinoSource({ domain: 'sales', surface: 'Bad Surface' }), /bad surface/);
});

test('routeFor prefers the target domain, then the first domain', () => {
  assert.deepEqual(routeFor({ domains: ['a', 'b'] }, 'catalog'), { domain: 'a', surface: 'catalog' });
  assert.deepEqual(routeFor({ domains: ['a', 'b'] }, 'catalog', 'b'), { domain: 'b', surface: 'catalog' });
  assert.deepEqual(routeFor({ domains: [] }, 'catalog'), { domain: '', surface: 'catalog' });
});

test('client tags carry the route', () => {
  assert.deepEqual(trinoClientTags({ domain: 'Sales', surface: 'ask' }), ['os-ui', 'domain=sales', 'surface=ask']);
});

test('the source matches the chart selector exactly (and an untagged or no-domain source does not)', () => {
  // The selector regex as the chart renders it (values.yaml trino.resourceGroups.config).
  const values = readFileSync(new URL('../../../charts/sovereign-agentic-os/values.yaml', import.meta.url), 'utf8');
  const m = values.match(/source: '(\^os-ui\/\(\?<domain>[^']+)'/);
  assert.ok(m, 'os-ui selector not found in values.yaml');
  const re = new RegExp(m[1]);
  assert.equal(re.exec(trinoSource({ domain: 'agentic-leader-q3-2026', surface: 'data-query' }))?.groups?.domain, 'agentic_leader_q3_2026');
  assert.equal(re.test(trinoSource({ domain: '', surface: 'data-query' })), false);
  assert.equal(re.test('trino-python-client'), false);
});

test('routeForTable: the schema is the domain; a personal lane uses the caller domain', async () => {
  const { routeForTable } = await import('@core/infra/trino-source');
  assert.deepEqual(routeForTable('iceberg.sales.gold_x', 'data-build'), { domain: 'sales', surface: 'data-build' });
  assert.deepEqual(routeForTable('iceberg.personal_u1.t', 'data-build', ['mkt']), { domain: 'mkt', surface: 'data-build' });
  assert.deepEqual(routeForTable('t', 'data-build'), { domain: '', surface: 'data-build' });
});

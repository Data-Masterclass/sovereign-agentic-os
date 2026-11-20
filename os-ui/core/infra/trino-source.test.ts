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
import { MAX_DOMAIN, routeDomain, routeFor, trinoClientTags, trinoSource } from '@core/infra/trino-source';

test('source is os-ui/<sanitised domain>/<surface>', () => {
  assert.equal(trinoSource({ domain: 'sales', surface: 'data-query' }), 'os-ui/sales/data-query');
  assert.equal(trinoSource({ domain: 'agentic-leader-q3-2026', surface: 'metrics' }), 'os-ui/agentic_leader_q3_2026/metrics');
  assert.equal(routeDomain(''), '_none');
  assert.equal(routeDomain(undefined), '_none');
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
  assert.equal(re.test('trino-python-client'), false);
  // NO SILENT FALLBACK: every route os-ui can build is captured by the selector, so no os-ui
  // query lands in global.other: no domain, punctuation-only, dashed, upper-case, long and very
  // long domains alike. An untagged or uncaptured route fails this test.
  const domains = ['', '---', 'Sales', 'agentic-leader-q3-2026', 'x'.repeat(48), 'y'.repeat(49),
    'agentic-leader-autumn-winter-2026-2027-with-a-much-longer-cohort-name', 'ä-ö-ü', '_lead_'];
  for (const domain of domains) {
    const src = trinoSource({ domain, surface: 'dashboards' });
    const got = re.exec(src)?.groups?.domain;
    assert.ok(got, `"${domain}" → ${src} is not captured (would land in global.other)`);
    assert.equal(got, routeDomain(domain));
  }
});

test('a long domain is shortened deterministically and stays a valid client tag', () => {
  const tag = /^[A-Za-z0-9._=:-]{1,64}$/; // images/extensions/query-tool/execute_guard.py _TAG
  const long = 'agentic-leader-autumn-winter-2026-2027-with-a-much-longer-cohort-name'; // 68 chars
  const d = routeDomain(long);
  assert.ok(d.length <= MAX_DOMAIN, d);
  assert.match(d, /^[a-z0-9_]+_[0-9a-f]{8}$/);
  assert.equal(routeDomain(long), d, 'deterministic');
  assert.notEqual(routeDomain(`${long}-b`), d, 'two long domains with one prefix do not share a group');
  assert.ok(routeDomain('z'.repeat(64)).length <= MAX_DOMAIN);
  for (const t of trinoClientTags({ domain: 'z'.repeat(64), surface: 'connections-land' })) assert.match(t, tag);
  // Up to MAX_DOMAIN characters the name is kept as is (it equals the Iceberg schema name).
  assert.equal(routeDomain('x'.repeat(MAX_DOMAIN)), 'x'.repeat(MAX_DOMAIN));
});

test('routeForTable: the schema is the domain; a personal lane uses the caller domain', async () => {
  const { routeForTable } = await import('@core/infra/trino-source');
  assert.deepEqual(routeForTable('iceberg.sales.gold_x', 'data-build', []), { domain: 'sales', surface: 'data-build' });
  assert.deepEqual(routeForTable('iceberg.personal_u1.t', 'data-build', ['mkt']), { domain: 'mkt', surface: 'data-build' });
  assert.deepEqual(routeForTable('t', 'data-build', []), { domain: '', surface: 'data-build' });
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The dashboard panel picker's PURE presentation helpers (os-ui 0.6.85): the chips are
 * grouped My / Domain / Company by the tier each metric carries, and the single-view
 * caption reads the FRIENDLY dataset name instead of the raw UPPER_SNAKE view id. These
 * are re-slice/lookup helpers with no I/O, so they unit-test directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMetricsByTier, metricTierSections, viewDatasetName, TIER_LABEL, VIZ_LABEL_KEY, MODE_LABEL_KEY, VIZ_TYPES } from '@tabs/dashboards/ui/shared';
import { textFor, CATALOG_LOCALES } from '@core/testing/catalog-text';
import type { MetricSummary } from '@tabs/dashboards/ui/shared';

const m = (over: Partial<MetricSummary>): MetricSummary => ({
  id: 'id', name: 'Metric', datasetId: 'ds', datasetName: 'Service Performance',
  member: 'SERVICE_PERFORMANCE.value', tier: 'personal', owner: 'u', type: 'number',
  ...over,
});

test('groupMetricsByTier buckets by the metric tier (My/Domain/Company)', () => {
  const list = [
    m({ id: 'a', tier: 'personal' }),
    m({ id: 'b', tier: 'domain' }),
    m({ id: 'c', tier: 'marketplace' }),
    m({ id: 'd', tier: 'personal' }),
  ];
  const b = groupMetricsByTier(list);
  assert.deepEqual(b.mine.map((x) => x.id), ['a', 'd']);
  assert.deepEqual(b.domain.map((x) => x.id), ['b']);
  assert.deepEqual(b.marketplace.map((x) => x.id), ['c']);
});

test('metricTierSections drops empty buckets and keeps My→Domain→Company order', () => {
  const list = [m({ id: 'a', tier: 'personal' }), m({ id: 'c', tier: 'marketplace' })];
  const sections = metricTierSections(list);
  // Domain is empty → no bare header for it.
  assert.deepEqual(sections.map((s) => s.key), ['mine', 'marketplace']);
  assert.deepEqual(sections.map((s) => s.label), ['My', 'Company']);
  assert.equal(sections[0].metrics[0].id, 'a');
  // A single-tier list stays flat (one section).
  assert.equal(metricTierSections([m({ tier: 'domain' })]).length, 1);
});

test('viewDatasetName maps a governed view id to its friendly dataset name', () => {
  const list = [
    m({ member: 'SERVICE_PERFORMANCE.value', datasetName: 'Service Performance' }),
    m({ member: 'OTHER_VIEW.value', datasetName: 'Other Dataset' }),
  ];
  assert.equal(viewDatasetName(list, 'SERVICE_PERFORMANCE'), 'Service Performance');
  assert.equal(viewDatasetName(list, 'OTHER_VIEW'), 'Other Dataset');
  // Unknown view → falls back to the raw id (never crashes), empty view → ''.
  assert.equal(viewDatasetName(list, 'UNSEEN_VIEW'), 'UNSEEN_VIEW');
  assert.equal(viewDatasetName(list, ''), '');
});

test('i18n: the scope, tier, viz and mode keys render the same English as before, in all seven languages', () => {
  const text = textFor('dashboards');
  const all = [m({ tier: 'personal' }), m({ tier: 'domain' }), m({ tier: 'marketplace' })];
  for (const s of metricTierSections(all)) assert.equal(text({ key: `scopeWord.${s.labelKey}` }), s.label);
  for (const tier of ['personal', 'domain', 'marketplace'] as const) assert.equal(text({ key: `tier.${tier}` }), TIER_LABEL[tier]);
  // The viz-type and mode labels were the raw ids in English — still are.
  for (const v of [...VIZ_TYPES, 'big_number_total'] as const) assert.equal(text({ key: `viz.${VIZ_LABEL_KEY[v]}` }), v);
  for (const mode of ['live', 'offline-mock'] as const) assert.equal(text({ key: `mode.${MODE_LABEL_KEY[mode]}` }), mode);
  for (const locale of CATALOG_LOCALES) {
    for (const v of Object.values(VIZ_LABEL_KEY)) assert.ok(text({ key: `viz.${v}` }, locale));
    for (const v of Object.values(MODE_LABEL_KEY)) assert.ok(text({ key: `mode.${v}` }, locale));
    for (const tier of ['personal', 'domain', 'marketplace']) {
      assert.ok(text({ key: `scopeWord.${tier}` }, locale));
      assert.ok(text({ key: `tier.${tier}` }, locale));
    }
  }
});

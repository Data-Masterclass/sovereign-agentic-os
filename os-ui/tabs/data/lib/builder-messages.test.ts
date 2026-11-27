/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The dataset detail page's (DataBuilder) catalog messages, tested without the component
 * USER STORY: As a maintainer I want the English a user reads on a dataset page to be exactly what it was before
 *             i18n, and every message the page uses to exist in all seven languages.
 * ARCHITECTURE: a test may not import a `.tsx`, so this renders the catalog keys DataBuilder/StageAssistant use
 *               through the English catalog and compares them with the strings the component used to build by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { textFor, CATALOG_LOCALES } from '@core/testing/catalog-text';

const text = textFor('data');

test('i18n: hand-built English sentences render byte-identically from the catalog', () => {
  // suggestionText
  assert.equal(text({ key: 'builder.suggestion.notNull', args: { column: 'email' } }), 'email is never empty');
  assert.equal(text({ key: 'builder.suggestion.acceptedValues', args: { column: 'status', values: '{open, closed}' } }), 'status is one of {open, closed}');
  assert.equal(text({ key: 'builder.suggestion.range', args: { column: 'amount', min: '0', max: '∞' } }), 'amount is in range 0–∞');
  assert.equal(text({ key: 'builder.suggestion.reference', args: { column: 'cid' } }), "cid exists in cid's referenced dataset");
  // preview + connected chips (plural replaces the old `row{n === 1 ? '' : 's'}`)
  assert.equal(text({ key: 'builder.preview.firstRows', args: { count: 1, layer: 'gold' } }), 'First 1 row · gold');
  assert.equal(text({ key: 'builder.preview.firstRows', args: { count: 50, layer: 'silver' } }), 'First 50 rows · silver');
  assert.equal(text({ key: 'builder.connected.dashboardChip', args: { name: 'Sales', count: 2 } }), 'Sales · 2 charts');
  assert.equal(text({ key: 'builder.connected.systemChip', args: { name: 'Ops', count: 1 } }), 'Ops · 1 agent');
  // view headings (the old `${Layer} data preview` / `— the ${layer} layer`)
  assert.equal(text({ key: 'builder.view.previewTitle', args: { layer: 'gold' } }), 'Gold data preview');
  assert.equal(text({ key: 'builder.view.previewTitle', args: { layer: 'none' } }), 'Data preview');
  assert.equal(text({ key: 'builder.view.previewSubtitle', args: { layer: 'bronze' } }), 'The first 50 rows of this dataset — the bronze layer.');
  assert.equal(text({ key: 'builder.view.previewSubtitle', args: { layer: 'none' } }), 'The first 50 rows of this dataset.');
  // scorecard
  assert.equal(text({ key: 'builder.view.passingOf', args: { passing: 3, ran: 4 } }), '3 of 4 checks passing');
  assert.equal(text({ key: 'builder.view.rulesAuthored', args: { count: 1 } }), '1 rule authored');
  assert.equal(text({ key: 'builder.view.cardFail', args: { count: 2 } }), '2 violating rows');
  assert.equal(text({ key: 'builder.checks.warnTitle', args: { count: '?' } }), 'dbt severity warn: ? row(s)');
  assert.equal(text({ key: 'builder.transform.stale', args: { bronze: 'A', silver: 'B' } }),
    'Newer data has arrived since the last transformation (A vs B) — save again to catch it up.');
  assert.equal(text({ key: 'builder.about.certifiedTitle', args: { level: 'gold', by: 'ann', date: 'Nov 1, 2026' } }), 'Certified gold by ann on Nov 1, 2026');
  assert.equal(text({ key: 'stageAssistant.requestFailed', args: { status: 503 } }), 'Request failed (503)');
});

/** Every leaf key path under the subtrees this page owns. */
function leaves(o: unknown, prefix = ''): string[] {
  if (typeof o === 'string') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

test('i18n: every page/builder/stages/stageAssistant/dqRules message exists and renders in all seven locales', () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), 'messages', 'en', 'data.json'), 'utf8')) as Record<string, unknown>;
  const keys = ['page', 'builder', 'stages', 'stageAssistant', 'dqRules'].flatMap((top) => leaves(en[top], top));
  assert.ok(keys.length > 250, `expected the full builder catalog, got ${keys.length}`);
  const args = { count: 2, column: 'c', values: 'v', min: '0', max: '1', layer: 'gold', name: 'n', owner: 'o', missing: 'm',
    bronze: 'b', silver: 's', date: 'd', rule: 'r', passing: 1, ran: 2, slug: 's', fqn: 'f', tier: 't', visibility: 'v',
    level: 'l', by: 'b', status: 500 };
  for (const loc of CATALOG_LOCALES) {
    for (const key of keys) {
      // Rich-text tags are rendered by the component; here each must at least parse and produce text.
      const out = text({ key, args: { ...args, strong: (c: string) => c, code: (c: string) => c, badge: (c: string) => c } as never }, loc);
      assert.ok(out.length > 0, `${loc} ${key}`);
    }
  }
});

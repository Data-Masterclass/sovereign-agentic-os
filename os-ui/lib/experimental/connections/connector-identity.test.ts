/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorIdentity, markStyle } from './connector-identity.ts';

/**
 * The connector visual-identity resolver behind the gallery showcase: curated monograms +
 * per-service accents win; unmapped keys derive an honest monogram from the label and a stable
 * accent; warehouse platforms resolve per-platform. No React — pure data + string math.
 */

test('curated keys resolve to their monogram + accent + business value', () => {
  const kajabi = connectorIdentity('kajabi-api');
  assert.equal(kajabi.monogram, 'KJ');
  assert.equal(kajabi.accent, '#4A55C7');
  assert.match(kajabi.value, /audience|offers|revenue/i);
});

test('warehouse platform wins over the generic warehouse key', () => {
  const bq = connectorIdentity('warehouse', { platform: 'bigquery' });
  assert.equal(bq.monogram, 'BQ');
  const generic = connectorIdentity('warehouse');
  assert.equal(generic.monogram, 'WH');
});

test('an unmapped key derives a monogram from the label (never blank)', () => {
  const id = connectorIdentity('acme-thing', { label: 'Acme Widgets (personal)' });
  assert.equal(id.monogram, 'AW');            // stop-words + parenthetical dropped
  assert.ok(id.accent.length > 0);
  assert.match(id.value, /Acme Widgets/);
});

test('a single-word label yields a two-letter slice', () => {
  assert.equal(connectorIdentity('x', { label: 'Zendesk' }).monogram, 'ZE');
});

test('the same key always gets the same fallback accent (stable hash)', () => {
  const a = connectorIdentity('mystery-key', { label: 'Mystery' }).accent;
  const b = connectorIdentity('mystery-key', { label: 'Mystery' }).accent;
  assert.equal(a, b);
});

test('markStyle produces the CSS custom-property bundle a tile spreads', () => {
  const s = markStyle('#4285F4');
  assert.equal(s['--mono-fg'], '#4285F4');
  assert.match(s['--mono-bg'], /color-mix/);
  assert.match(s['--tile-line'], /color-mix/);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Characterisation of Monitoring's shared formatters
 * USER STORY: As a maintainer who merged two copies of `ago`/`money`/`compact`, I want the exact
 *             strings the page and the drawer printed before the merge pinned down.
 * ARCHITECTURE:
 *   - Pure inputs and outputs; `ago` is measured against `Date.now()` with generous offsets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, compact, money } from '@tabs/monitoring/ui/format';

test('ago: absent and unparseable are a dash, then minutes, hours, days, months', () => {
  const now = Date.now();
  assert.equal(ago(null), '—');
  assert.equal(ago('not a date'), '—');
  assert.equal(ago(now - 10_000), 'just now');
  assert.equal(ago(now + 60_000), 'just now');
  assert.equal(ago(now - 5 * 60_000 - 1000), '5m ago');
  assert.equal(ago(new Date(now - 3 * 3600_000 - 1000).toISOString()), '3h ago');
  assert.equal(ago(now - 2 * 86400_000 - 1000), '2d ago');
  assert.equal(ago(now - 65 * 86400_000), '2mo ago');
});

test('money: unpriced is a dash, sub-euro gets three decimals', () => {
  assert.equal(money(0), '—');
  assert.equal(money(-1), '—');
  assert.equal(money(0.0123), '€0.012');
  assert.equal(money(1), '€1.00');
  assert.equal(money(12.345), '€12.35');
});

test('compact: thousands get one decimal and a k', () => {
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1.0k');
  assert.equal(compact(12345), '12.3k');
});

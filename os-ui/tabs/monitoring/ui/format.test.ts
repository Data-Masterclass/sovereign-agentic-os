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
import { ago, compact, count, day, decimals, dur, euros, gib, money, ms, pct, pct100, stamp, usd } from '@tabs/monitoring/ui/format';

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

test('usd: the LiteLLM ledger unit — a dollar sign, zero is $0.00 (a real zero, not unknown), never €', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(1.25), '$1.25');
  assert.equal(usd(0.0123), '$0.012');
  assert.ok(!usd(3).includes('€'));
});

test('the panel helpers keep their English output (ms, dur, pct, gib, decimals, count, euros, day, stamp)', () => {
  assert.equal(ms(null), '—');
  assert.equal(ms(850.4), '850 ms');
  assert.equal(ms(1500), '1.5 s');
  assert.equal(ms(12_345), '12 s');
  assert.equal(dur(undefined), '—');
  assert.equal(dur(850.4), '850ms');
  assert.equal(dur(1500), '1.5s');
  assert.equal(pct(undefined), '—');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct100(80), '80%');
  assert.equal(gib(1.5 * (1 << 30)), '1.5 GiB');
  assert.equal(gib(512 * (1 << 20)), '512 MiB');
  assert.equal(decimals(0.254, 2), '0.25');
  assert.equal(count(1234), '1234');
  assert.equal(euros(120), '€120');
  assert.equal(day('2026-11-27'), '2026-11-27');
  assert.equal(stamp('2026-11-27T10:00:00Z'), '2026-11-27T10:00:00Z');
});

test('an explicit "en" locale is the same as the default', () => {
  const now = Date.now();
  assert.equal(ago(now - 5 * 60_000 - 1000, 'en'), '5m ago');
  assert.equal(money(12.345, 'en'), '€12.35');
  assert.equal(compact(12345, 'en'), '12.3k');
  assert.equal(usd(0.0123, 'en'), '$0.012');
});

test('German gets its own separators, currency position and relative phrases', () => {
  const now = Date.now();
  assert.equal(ago(null, 'de'), '—');
  assert.match(ago(now - 5 * 60_000 - 1000, 'de'), /5 Min/);
  assert.equal(money(0, 'de'), '—');
  assert.match(money(12.345, 'de'), /^12,35\s€$/);
  assert.match(usd(1.25, 'de'), /^1,25\s\$$/);
  assert.equal(count(1234, 'de'), '1.234');
  assert.equal(decimals(0.254, 2, 'de'), '0,25');
  assert.match(pct(0.456, 'de'), /^46\s%$/);
  assert.equal(ms(1500, 'de'), '1,5 s');
  assert.equal(dur(1500, 'de'), '1,5s');
  assert.equal(gib(1.5 * (1 << 30), 'de'), '1,5 GiB');
  assert.equal(day('2026-11-27', 'de'), '27.11.26');
  assert.equal(stamp('not a date', 'de'), 'not a date');
  assert.notEqual(compact(12345, 'de'), '12.3k');
});

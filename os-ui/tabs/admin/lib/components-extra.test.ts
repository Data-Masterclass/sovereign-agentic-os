/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the Components & Health augmentation (B3-review-H-4)
 * USER STORY: As a reviewer I want proof that a failed or STALLED Trino rules reconcile shows up
 *             RED on the Platform surface, because the reconciler itself is fail-soft and a
 *             silent failure leaves the chart's permissive bootstrap in force.
 * ARCHITECTURE: Pure — the outcome, the clock and the interval are all injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trinoAccessRulesRow, type AccessRulesOutcome } from '@tabs/admin/lib/components-extra';

const PERIOD = 10 * 60 * 1000;
const NOW = 1_000_000_000;
const ok = (at: number): AccessRulesOutcome => ({ ok: true, code: 'written', detail: '2 domain(s)', at });
const bad = (at: number): AccessRulesOutcome => ({ ok: false, code: 'forbidden', detail: 'may not read it', at });

test('the feature off grows no row at all', () => {
  assert.equal(trinoAccessRulesRow({ enabled: false, outcome: bad(NOW), now: NOW, periodMs: PERIOD }), null);
});

test('enabled but never attempted is amber and says the bootstrap is in force', () => {
  const row = trinoAccessRulesRow({ enabled: true, outcome: null, now: NOW, periodMs: PERIOD })!;
  assert.equal(row.health, 'amber');
  assert.match(row.detail, /bootstrap/);
  assert.equal(row.at, undefined);
});

test('a failed reconcile is RED and names the code', () => {
  const row = trinoAccessRulesRow({ enabled: true, outcome: bad(NOW - 1000), now: NOW, periodMs: PERIOD })!;
  assert.equal(row.health, 'red');
  assert.match(row.detail, /forbidden/);
  assert.match(row.detail, /ownership is open/);
  assert.equal(row.at, NOW - 1000);
});

test('a fresh success is green', () => {
  const row = trinoAccessRulesRow({ enabled: true, outcome: ok(NOW - PERIOD), now: NOW, periodMs: PERIOD })!;
  assert.equal(row.health, 'green');
});

test('a success older than TWICE the repair interval is RED — the loop is gone', () => {
  const fresh = trinoAccessRulesRow({ enabled: true, outcome: ok(NOW - 2 * PERIOD), now: NOW, periodMs: PERIOD })!;
  assert.equal(fresh.health, 'green', 'exactly 2x is still inside the window');
  const stale = trinoAccessRulesRow({ enabled: true, outcome: ok(NOW - 2 * PERIOD - 1), now: NOW, periodMs: PERIOD })!;
  assert.equal(stale.health, 'red');
  assert.match(stale.detail, /not running/);
});

test('the row id is stable — a surface keys off it', () => {
  const row = trinoAccessRulesRow({ enabled: true, outcome: ok(NOW), now: NOW, periodMs: PERIOD })!;
  assert.equal(row.id, 'trino-access-rules');
  assert.equal(row.name, 'Trino access rules');
});

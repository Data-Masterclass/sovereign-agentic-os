/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainPulseStub, healthCostStub } from './stubs.ts';

test('the cross-tab feeds are HONESTLY marked as mock (no fake "live")', () => {
  assert.equal(domainPulseStub('sales').source, 'mock');
  assert.equal(healthCostStub('amir', 'sales').source, 'mock');
});

test('no-drift: the stub is the SINGLE source — same input, identical output', () => {
  // Home reads exactly what the adapter returns and never recomputes, so two
  // reads of the same scope must be byte-identical (the no-drift guarantee).
  assert.deepEqual(domainPulseStub('sales'), domainPulseStub('sales'));
  assert.deepEqual(healthCostStub('amir', 'sales'), healthCostStub('amir', 'sales'));
});

test('feeds are scoped: different domain / viewer → distinct figures', () => {
  assert.notDeepEqual(domainPulseStub('sales'), domainPulseStub('finance'));
  assert.notDeepEqual(healthCostStub('amir', 'sales'), healthCostStub('maria', 'finance'));
});

test('pulse + health stay within sane bounds', () => {
  const p = domainPulseStub('sales');
  assert.ok(p.valuePct >= 0 && p.valuePct <= 100);
  assert.ok(p.bets.length > 0);
  const h = healthCostStub('amir', 'sales');
  assert.ok(h.spendUsd >= 0 && h.spendUsd <= h.capUsd);
  assert.ok(h.spendPct >= 0 && h.spendPct <= 1);
});

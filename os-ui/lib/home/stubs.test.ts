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

test('a fresh tenant has an EMPTY cockpit — no fabricated activity', () => {
  // The stubs return an honest empty state until real Strategy/Monitoring
  // artifacts exist; the scope-distinct figures only appear once seeded.
  const p = domainPulseStub('sales');
  assert.equal(p.valuePct, 0);
  assert.equal(p.bets.length, 0);
  assert.equal(p.activeCreators, 0);
  const h = healthCostStub('amir', 'sales');
  assert.equal(h.redItems.length, 0);
  assert.equal(h.spendUsd, 0);
});

test('pulse + health stay within sane bounds', () => {
  const p = domainPulseStub('sales');
  assert.ok(p.valuePct >= 0 && p.valuePct <= 100);
  const h = healthCostStub('amir', 'sales');
  assert.ok(h.spendUsd >= 0 && h.spendUsd <= h.capUsd);
  assert.ok(h.spendPct >= 0 && h.spendPct <= 1);
});

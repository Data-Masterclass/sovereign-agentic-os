/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { domainPulseStub, healthCostStub } from './stubs.ts';
import { setCap, addSpend, __resetCost } from '@/lib/governance';

// ── Contract: fresh tenant shows real 0s, source is 'live' ────────────────────

test('live feeds are marked source: "live" (not mock)', async () => {
  const p = await domainPulseStub('sales');
  assert.equal(p.source, 'live');
  const h = healthCostStub('amir', 'sales');
  assert.equal(h.source, 'live');
});

test('no-drift: same inputs → identical output', async () => {
  const p1 = await domainPulseStub('sales');
  const p2 = await domainPulseStub('sales');
  assert.deepEqual(p1, p2);
  const h1 = healthCostStub('amir', 'sales');
  const h2 = healthCostStub('amir', 'sales');
  assert.deepEqual(h1, h2);
});

test('a fresh tenant has an EMPTY cockpit — no fabricated activity', async () => {
  // All-zero pulse is honest real state.
  const p = await domainPulseStub('sales');
  // activeCreators counts real users: bootstrap admin is role=admin not creator → 0.
  assert.equal(p.activeCreators, 0);

  const h = healthCostStub('amir', 'sales');
  assert.equal(h.redItems.length, 0);
  assert.equal(h.spendUsd, 0);
  assert.equal(h.capUsd, 0);
});

test('pulse + health stay within sane bounds', async () => {
  const p = await domainPulseStub('sales');
  assert.ok(p.activeCreators >= 0, 'activeCreators must be >= 0');
  const h = healthCostStub('amir', 'sales');
  assert.ok(h.spendUsd >= 0, 'spendUsd must be >= 0');
  assert.ok(h.capUsd >= 0, 'capUsd must be >= 0');
  assert.ok(h.spendPct >= 0 && h.spendPct <= 1, 'spendPct must be in [0, 1]');
});

// ── Real store data: health reflects a cap + spend set in governance ───────────

test('health.capUsd and health.spendUsd reflect a real domain cap + spend', () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: 500, period: 'month', createdBy: 'admin' });
  addSpend('domain', 'eng', 120);

  const h = healthCostStub('', 'eng');
  assert.equal(h.capUsd, 500, 'capUsd must equal the set limit');
  assert.equal(h.spendUsd, 120, 'spendUsd must equal the recorded spend');
  assert.ok(Math.abs(h.spendPct - 0.24) < 0.001, 'spendPct must be spend / cap');
  assert.equal(h.source, 'live');

  __resetCost();
});

test('health falls back to tenant cap when no domain cap is set', () => {
  __resetCost();
  setCap({ scope: 'tenant', subject: 'tenant', limit: 2000, period: 'month', createdBy: 'admin' });
  addSpend('tenant', 'tenant', 400);

  // Domain 'sales' has no explicit cap → should show tenant cap.
  const h = healthCostStub('', 'sales');
  assert.equal(h.capUsd, 2000, 'should fall back to tenant cap');
  assert.equal(h.spendUsd, 400, 'should show tenant spend');
  assert.ok(Math.abs(h.spendPct - 0.2) < 0.001);

  __resetCost();
});

test('health: domain cap takes precedence over tenant cap', () => {
  __resetCost();
  setCap({ scope: 'tenant', subject: 'tenant', limit: 2000, period: 'month', createdBy: 'admin' });
  setCap({ scope: 'domain', subject: 'eng', limit: 300, period: 'month', createdBy: 'admin' });
  addSpend('domain', 'eng', 60);
  addSpend('tenant', 'tenant', 500);

  const h = healthCostStub('', 'eng');
  assert.equal(h.capUsd, 300, 'domain cap should win over tenant cap');
  assert.equal(h.spendUsd, 60, 'should show domain spend, not tenant spend');

  __resetCost();
});

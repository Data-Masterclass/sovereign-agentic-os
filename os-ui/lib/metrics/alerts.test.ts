/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOn, evaluateAlert } from './alerts.ts';
import { measureFromForm } from './model.ts';
import { goldSales } from './fixtures.ts';

const measure = measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] });

test('alert is built on the canonical metric member', () => {
  const rule = alertOn(goldSales(), measure, { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email'] });
  assert.equal(rule.member, 'Sales.revenue');
});

test('breach notifies AND triggers a governed agent run (traced)', () => {
  const rule = alertOn(goldSales(), measure, {
    id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email', 'slack'],
    triggerAgent: { systemId: 'sales', agent: 'sales-agent', preset: 'recovery-note' },
  });
  const breached = evaluateAlert(rule, 42000);
  assert.ok(breached.breached);
  assert.equal(breached.notifications.length, 2);
  assert.ok(breached.agentRun);
  assert.equal(breached.agentRun?.traced, true);
  assert.match(breached.agentRun?.reason ?? '', /Sales.revenue = 42000 lt 50000/);

  const fine = evaluateAlert(rule, 60000);
  assert.equal(fine.breached, false);
  assert.equal(fine.agentRun, null);
  assert.equal(fine.notifications.length, 0);
});

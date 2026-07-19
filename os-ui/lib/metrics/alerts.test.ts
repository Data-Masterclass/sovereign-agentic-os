/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOn, evaluateAlert } from './alerts.ts';
import { measureFromForm } from './model.ts';
import { goldSales } from './fixtures.ts';
import { saveAlertRule, listAlertRules, recordEvaluation, __resetAlertStore } from './alert-store.ts';

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

// --- alert-store: durable rule persistence -----------------------------------

test('alert-store: saveAlertRule persists a rule and listAlertRules returns it', () => {
  __resetAlertStore();
  const rule = alertOn(goldSales(), measure, { id: 'store-test-1', comparator: 'gt', threshold: 100, notify: ['in_app'] });
  const saved = saveAlertRule(rule, 'alice', 'sales');
  assert.equal(saved.id, 'store-test-1');
  assert.equal(saved.owner, 'alice');
  assert.equal(saved.domain, 'sales');
  assert.ok(saved.createdAt, 'createdAt is set on first save');

  const all = listAlertRules();
  assert.ok(all.some((r) => r.id === 'store-test-1'), 'listAlertRules (no filter) returns the saved rule');

  const mine = listAlertRules('alice');
  assert.ok(mine.some((r) => r.id === 'store-test-1'), 'listAlertRules(owner) returns the rule for the owner');

  const notMine = listAlertRules('bob');
  assert.ok(!notMine.some((r) => r.id === 'store-test-1'), 'listAlertRules(other owner) does NOT return it');
});

test('alert-store: recordEvaluation updates lastValue and lastBreached', () => {
  __resetAlertStore();
  const rule = alertOn(goldSales(), measure, { id: 'eval-test-1', comparator: 'lt', threshold: 50000, notify: ['email'] });
  saveAlertRule(rule, 'alice', 'sales');

  const updated = recordEvaluation('eval-test-1', 42000, true);
  assert.ok(updated, 'recordEvaluation returns the updated record');
  assert.equal(updated!.lastValue, 42000);
  assert.equal(updated!.lastBreached, true);
  assert.ok(updated!.lastEvaluated, 'lastEvaluated timestamp is set');

  // Mark as not breached
  const updated2 = recordEvaluation('eval-test-1', 60000, false);
  assert.equal(updated2!.lastBreached, false);
  assert.equal(updated2!.lastValue, 60000);
});

test('alert-store: recordEvaluation returns null for unknown rule id', () => {
  __resetAlertStore();
  const result = recordEvaluation('nonexistent', 100, false);
  assert.equal(result, null);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Unit tests for the pure alert-derivation engine (alerts-derive.ts).
 * Bug-1 fix: alerts must derive from real in-process signals, never from
 * MOCK_ALERTS. These tests seed synthetic inputs and verify the outputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAlerts } from './alerts-derive.ts';
import { deriveScope } from './scope-core.ts';

const admin = deriveScope('admin', 'a_root', ['sales', 'finance', 'platform']);
const salesUser = deriveScope('creator', 'u_sales_rep', ['sales']);

// ── run-failure alerts ────────────────────────────────────────────────────────

test('Bug-1: derives critical alert from a failed run (error output)', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-err-1', principal: 'u_sales_rep', tool: 'metrics', output: 'ERROR: upstream stale' }],
    [],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[0].links?.runId, 'r-err-1');
  assert.equal(alerts[0].source, 'live');
});

test('Bug-1: derives critical alert from a failed run ("fail" in output)', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-fail-1', principal: 'u_sales_rep', tool: 'retrieve', output: 'run failed: tool timeout' }],
    [],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
});

test('Bug-1: derives warning alert from a governance-denied run', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-deny-1', principal: 'u_finance', tool: 'write_file', decision: 'deny', output: 'denied' }],
    [],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.ok(alerts[0].title.includes('blocked'));
  assert.equal(alerts[0].source, 'live');
});

test('Bug-1: clean run (green output, no denial) produces no alert', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-ok-1', principal: 'u_sales_rep', tool: 'retrieve', output: '2 passages returned' }],
    [],
    admin,
  );
  assert.equal(alerts.length, 0);
});

test('Bug-1: "aborted" in output triggers critical alert', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-abort', principal: 'u_sales_rep', tool: 'supervisor', output: 'run aborted — missing input' }],
    [],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
});

// ── cost-cap alerts ───────────────────────────────────────────────────────────

test('Bug-1: derives critical alert when cap is breached (spent > limit)', () => {
  const alerts = deriveAlerts(
    [],
    [{ id: 'cap-sales-monthly', scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root', spent: 210 }],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.ok(alerts[0].title.includes('breached'));
  assert.equal(alerts[0].links?.capRef, 'cap-sales-monthly');
  assert.equal(alerts[0].source, 'live');
});

test('Bug-1: derives warning alert when spend is ≥90% of cap', () => {
  const alerts = deriveAlerts(
    [],
    [{ id: 'cap-sales-monthly', scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root', spent: 182 }],
    admin,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.ok(alerts[0].title.includes('nearing'));
  assert.equal(alerts[0].source, 'live');
});

test('Bug-1: no alert when spend is below 90% of cap', () => {
  const alerts = deriveAlerts(
    [],
    [{ id: 'cap-finance-monthly', scope: 'domain', subject: 'finance', limit: 300, period: 'month', createdBy: 'a_root', spent: 54 }],
    admin,
  );
  assert.equal(alerts.length, 0);
});

test('Bug-1: no alert when there is no recorded spend (spent=0)', () => {
  const alerts = deriveAlerts(
    [],
    [{ id: 'cap-new', scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root', spent: 0 }],
    admin,
  );
  assert.equal(alerts.length, 0, 'No alert until spend is actually recorded');
});

// ── honest empty ──────────────────────────────────────────────────────────────

test('Bug-1: returns [] when there are no failed runs and no breached caps', () => {
  assert.deepEqual(deriveAlerts([], [], admin), []);
});

// ── scope filtering ───────────────────────────────────────────────────────────

test('Bug-1: scope-filter — sales user only sees own run alert, not finance run alert', () => {
  const alerts = deriveAlerts(
    [
      { id: 'r-sales-fail', principal: 'u_sales_rep', tool: 'metrics', output: 'ERROR: stale' },
      { id: 'r-finance-fail', principal: 'u_finance_rep', tool: 'metrics', output: 'ERROR: stale' },
    ],
    [],
    salesUser,
  );
  // Creator scope: only own-principal alerts survive
  assert.ok(alerts.every((a) => a.owner === 'u_sales_rep'),
    'Sales user must not see finance run alerts');
});

test('Bug-1: all alerts source is "live" (never "mock")', () => {
  const alerts = deriveAlerts(
    [{ id: 'r-fail', principal: 'u_sales_rep', tool: 'metrics', output: 'ERROR: x' }],
    [{ id: 'cap-over', scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root', spent: 201 }],
    admin,
  );
  assert.ok(alerts.length > 0, 'Expected at least one alert');
  assert.ok(alerts.every((a) => a.source === 'live'), 'All derived alerts must be source:live');
});

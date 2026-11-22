/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A commit dbt refused is an alert, with dbt's own text (ownership rule: git owns models)
 * USER STORY: As an engineer who pushed a model I want the OS to tell me that dbt refused my commit
 *             and why, because Dagster stays on the last good commit and nothing else says so.
 * ARCHITECTURE: pure over the newest `dbt-parse` row per domain (`commit_checks`, written by
 *             repo-sync's verdict copy). A passed or pending head raises nothing; an unreadable
 *             store raises a warning, never silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbtVerdictAlerts, type DbtVerdictRow } from '@tabs/monitoring/lib/dbt-verdict-alerts-core';

const sha = (c: string) => c.repeat(40);
const row = (domain: string, c: string, status: DbtVerdictRow['status'], at: string, details: Record<string, unknown> = {}): DbtVerdictRow => ({ domain, sha: sha(c), status, checkedAt: at, details });

test('a refused head raises a warning carrying dbt text, domain and short sha', () => {
  const a = dbtVerdictAlerts([row('sales', 'a', 'failed', '2026-11-22T10:00:00Z', { errorSummary: 'Compilation Error in model x: ref not found' })]);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.equal(a[0].domain, 'sales');
  assert.match(a[0].title, /sales/);
  assert.match(a[0].detail, /aaaaaaa/);
  assert.match(a[0].detail, /ref not found/);
  assert.match(a[0].detail, /last commit that passed/i);
  assert.equal(a[0].source, 'live');
});

test('twin: a passed head, or one still pending, raises nothing', () => {
  assert.deepEqual(dbtVerdictAlerts([row('sales', 'a', 'passed', '2026-11-22T10:00:00Z'), row('ops', 'b', 'pending', '2026-11-22T10:00:00Z')]), []);
});

test('twin: an old refusal superseded by a newer passed commit raises nothing', () => {
  assert.deepEqual(dbtVerdictAlerts([row('sales', 'a', 'failed', '2026-11-22T09:00:00Z'), row('sales', 'b', 'passed', '2026-11-22T10:00:00Z')]), []);
});

test('only the newest row per domain counts, and each domain is judged on its own', () => {
  const a = dbtVerdictAlerts([row('sales', 'a', 'passed', '2026-11-22T09:00:00Z'), row('sales', 'b', 'failed', '2026-11-22T10:00:00Z'), row('ops', 'c', 'passed', '2026-11-22T10:00:00Z')]);
  assert.deepEqual(a.map((x) => x.domain), ['sales']);
});

test('a missing error text is said, not invented', () => {
  const a = dbtVerdictAlerts([row('sales', 'a', 'failed', '2026-11-22T10:00:00Z')]);
  assert.match(a[0].detail, /no error text/i);
});

test('an unreadable store is a warning, never an empty list', () => {
  const a = dbtVerdictAlerts(null, 'connection refused');
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].detail, /connection refused/);
});

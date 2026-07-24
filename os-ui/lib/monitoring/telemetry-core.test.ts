/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollupAgentTelemetry,
  rollupDatasetTelemetry,
  summarizeDq,
  dailySeries,
  type RawRun,
} from './telemetry-core.ts';

const NOW = Date.parse('2026-06-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function run(overrides: Partial<RawRun> = {}): RawRun {
  return { id: 'r', at: NOW - DAY, health: 'ok', ...overrides };
}

test('rollupAgentTelemetry sums cost/tokens/runs and finds the last run', () => {
  const t = rollupAgentTelemetry(
    [
      run({ id: 'a', at: NOW - 2 * DAY, costUsd: 0.5, tokens: 100 }),
      run({ id: 'b', at: NOW - DAY, costUsd: 1.25, tokens: 200 }),
      run({ id: 'c', at: NOW - 3 * 60 * 1000, costUsd: 0.25, tokens: 50 }),
    ],
    NOW,
  );
  assert.equal(t.runs, 3);
  assert.equal(t.costUsd, 2);
  assert.equal(t.tokens, 350);
  assert.equal(t.lastRunAt, NOW - 3 * 60 * 1000);
  assert.equal(t.overall, 'ok');
  assert.equal(t.warnings, 0);
  assert.equal(t.errors, 0);
});

test('rollupAgentTelemetry ignores runs older than 7 days and future runs', () => {
  const t = rollupAgentTelemetry(
    [
      run({ id: 'old', at: NOW - 8 * DAY, costUsd: 99, tokens: 9999 }),
      run({ id: 'future', at: NOW + DAY, costUsd: 99, tokens: 9999 }),
      run({ id: 'in', at: NOW - DAY, costUsd: 1, tokens: 10 }),
    ],
    NOW,
  );
  assert.equal(t.runs, 1);
  assert.equal(t.costUsd, 1);
  assert.equal(t.tokens, 10);
});

test('rollupAgentTelemetry counts warnings + errors and picks worst overall', () => {
  const warnOnly = rollupAgentTelemetry([run({ health: 'warn' }), run({ health: 'ok' })], NOW);
  assert.equal(warnOnly.warnings, 1);
  assert.equal(warnOnly.errors, 0);
  assert.equal(warnOnly.overall, 'warn');

  const withError = rollupAgentTelemetry(
    [run({ health: 'warn' }), run({ health: 'error' }), run({ health: 'ok' })],
    NOW,
  );
  assert.equal(withError.warnings, 1);
  assert.equal(withError.errors, 1);
  assert.equal(withError.overall, 'error');
});

test('rollupAgentTelemetry with no runs is all-zero and never fabricates', () => {
  const t = rollupAgentTelemetry([], NOW);
  assert.deepEqual(t, {
    costUsd: 0,
    tokens: 0,
    runs: 0,
    lastRunAt: null,
    warnings: 0,
    errors: 0,
    overall: 'ok',
  });
});

test('rollupAgentTelemetry treats missing cost/tokens as 0, not NaN', () => {
  const t = rollupAgentTelemetry([run({ costUsd: undefined, tokens: undefined })], NOW);
  assert.equal(t.costUsd, 0);
  assert.equal(t.tokens, 0);
  assert.equal(t.runs, 1);
});

test('rollupDatasetTelemetry tallies pass/fail/not_run and derives overall', () => {
  const passing = rollupDatasetTelemetry(['pass', 'pass', 'not_run']);
  assert.equal(passing.checksPassing, 2);
  assert.equal(passing.checksNotRun, 1);
  assert.equal(passing.overall, 'ok');

  const failing = rollupDatasetTelemetry(['pass', 'fail']);
  assert.equal(failing.checksFailing, 1);
  assert.equal(failing.errors, 1);
  assert.equal(failing.overall, 'error');
});

test('rollupDatasetTelemetry staleness is a warning, pipeline break is an error', () => {
  const stale = rollupDatasetTelemetry([], { stalenessWarn: true });
  assert.equal(stale.warnings, 1);
  assert.equal(stale.overall, 'warn');

  const broken = rollupDatasetTelemetry([], { pipelineError: true });
  assert.equal(broken.errors, 1);
  assert.equal(broken.overall, 'error');
});

test('summarizeDq tallies passing/violated/not-run and lists violated rules', () => {
  const s = summarizeDq([
    { id: '1', label: 'not_null(email)', status: 'pass', violations: 0 },
    { id: '2', label: 'unique(id)', status: 'fail', violations: 4 },
    { id: '3', label: 'range(age,0,120)', status: 'fail', violations: 1 },
    { id: '4', label: 'legacy note', status: 'not_run', violations: null },
  ]);
  assert.equal(s.rules, 4);
  assert.equal(s.passing, 1);
  assert.equal(s.violated, 2);
  assert.equal(s.notRun, 1);
  assert.equal(s.hasRun, true);
  assert.deepEqual(s.violatedRules.map((r) => r.label), ['unique(id)', 'range(age,0,120)']);
});

test('summarizeDq is honest with no run vs no rules', () => {
  const noRun = summarizeDq(null);
  assert.equal(noRun.hasRun, false);
  assert.equal(noRun.rules, 0);
  assert.equal(noRun.violated, 0);

  const noRules = summarizeDq([]);
  assert.equal(noRules.hasRun, true); // a run happened, it just had no rules
  assert.equal(noRules.rules, 0);
});

test('dailySeries produces exactly N stable buckets with per-day sums', () => {
  const s = dailySeries(
    [
      run({ at: NOW, costUsd: 2 }),
      run({ at: NOW - 30 * 60 * 1000, costUsd: 3 }), // same UTC day as NOW
      run({ at: NOW - 6 * DAY, costUsd: 1 }),
      run({ at: NOW - 20 * DAY, costUsd: 99 }), // out of window → dropped
    ],
    NOW,
    (r) => r.costUsd ?? 0,
    7,
  );
  assert.equal(s.length, 7);
  assert.equal(s[0].value, 1); // oldest bucket (6 days ago)
  assert.equal(s[6].value, 5); // newest bucket (today: 2 + 3)
  const total = s.reduce((a, b) => a + b.value, 0);
  assert.equal(total, 6); // 99 excluded
});

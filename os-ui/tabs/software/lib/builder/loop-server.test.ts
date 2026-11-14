/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the persisted acceptance scorecard and the budget-aware iteration bound
 * USER STORY: As the Builder who has to approve a deploy I want the build's acceptance result
 *             committed beside the code it describes, so the review card can show whether the app
 *             actually satisfies its stories — and I want a build near its cost cap to stop early
 *             and honestly rather than die mid-iteration.
 * ARCHITECTURE:
 *   - `acceptanceRecord` and `builderIterationBudget` are the two pure exports of the otherwise
 *     side-effectful `loop-server.ts`, tested directly. The cost cap is driven through the real
 *     `core/policy/cost` store (`setCap` / `__resetCost`), not a mock of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { __resetCost, setCap } from '@core/policy/cost';
import { deriveAcceptanceChecks, scoreAcceptanceChecks } from './acceptance.ts';
import type { GroundingStory, SourceFile } from './grounding.ts';
import { MAX_BUILDER_ITERATIONS } from './loop.ts';
import { ACCEPTANCE_FILE, BUILDER_ITERATION_COST_USD, acceptanceRecord, builderIterationBudget } from './loop-server.ts';

const story: GroundingStory = {
  epicId: 'e1',
  storyId: 's1',
  title: 'See every open invoice',
  features: [],
  nfrs: ['loads fast'],
  rules: [],
};
const checks = deriveAcceptanceChecks([story]);
const files: SourceFile[] = [
  { path: 'src/epics/e1/s1/Page.tsx', content: 'export const rows = () => os.datasets.query("ds_1");\n' },
];
const scores = scoreAcceptanceChecks(checks, [story], files, { gated: true, ok: true, errors: [] });

test('M-5 the acceptance record is a small, honest summary plus the per-check evidence', () => {
  const rec = acceptanceRecord({
    appId: 'app_1',
    target: 'e1/s1',
    userId: 'dan',
    iterations: 2,
    checks,
    scores,
    groundingGaps: ['dataset ds_2: not readable'],
    at: '2026-11-14T00:00:00.000Z',
  });
  assert.equal(rec.version, 1);
  assert.equal(rec.appId, 'app_1');
  assert.equal(rec.target, 'e1/s1');
  assert.equal(rec.builder, 'agentic');
  assert.equal(rec.by, 'dan');
  assert.equal(rec.at, '2026-11-14T00:00:00.000Z');
  assert.equal(rec.iterations, 2);
  assert.equal(rec.scored, true);
  assert.equal(rec.ok, true);
  assert.equal(rec.reason, 'acceptance-passed');
  assert.equal(rec.total, checks.length);
  assert.equal(rec.manual, 1, 'the NFR stays a human check');
  // Every derived check is present WITH its evidence, so the card can name the unmet story.
  assert.equal(rec.checks.length, checks.length);
  const render = rec.checks.find((c) => c.kind === 'render');
  assert.equal(render?.story, 'e1/s1');
  assert.equal(render?.status, 'pass');
  assert.ok(render?.evidence.includes('static check (AST)'));
  // The grounding gaps ride along — an approver must see that the brief was thin.
  assert.deepEqual(rec.groundingGaps, ['dataset ds_2: not readable']);
  // It is JSON-serialisable (it is committed as a file).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(rec)));
});

test('M-5 an UNSCORED build records `scored: false`, with every check marked not-scored', () => {
  const rec = acceptanceRecord({
    appId: 'app_1',
    target: 'all',
    userId: 'dan',
    iterations: 4,
    checks,
    scores: [],
    groundingGaps: [],
  });
  assert.equal(rec.scored, false);
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, 'acceptance-incomplete', 'a persisted record never says "in progress"');
  assert.equal(rec.total, 0);
  for (const c of rec.checks) {
    assert.equal(c.status, 'not-scored');
    assert.equal(c.evidence, 'not scored');
  }
});

test('M-5 the record lands at a stable, committed path', () => {
  assert.equal(ACCEPTANCE_FILE, '.app/acceptance.json');
});

// ------------------------------------------- L-1: the budget-aware bound ----------

const user: CurrentUser = { id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' };

test('L-1 no cost cap means the loop keeps its own bound', () => {
  __resetCost();
  assert.equal(builderIterationBudget(user), undefined);
});

test('L-1 a cap LOWERS the bound to what the domain can still pay for', () => {
  __resetCost();
  // Headroom for ~2 iterations at the assumed per-iteration cost.
  setCap({ scope: 'domain', subject: 'eng', limit: BUILDER_ITERATION_COST_USD * 2, period: 'month' });
  assert.equal(builderIterationBudget(user), 2);
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: BUILDER_ITERATION_COST_USD * 3.9, period: 'month' });
  assert.equal(builderIterationBudget(user), 3, 'rounds DOWN — never start an iteration it cannot pay for');
});

test('L-1 a generous cap never RAISES the bound above the loop ceiling', () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: 10_000, period: 'month' });
  assert.equal(builderIterationBudget(user), MAX_BUILDER_ITERATIONS);
});

test('L-1 an exhausted cap still allows ONE iteration, which fails honestly', () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: 0, period: 'month' });
  assert.equal(builderIterationBudget(user), 1);
});

test('L-1 a user with no domain is not budget-bounded by a domain cap', () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: 1, period: 'month' });
  assert.equal(builderIterationBudget({ ...user, domains: [] }), undefined);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, allChecksPass, type Check } from '@tabs/agents/lib/build/run-checks';
import type { DiagRun } from '@tabs/agents/lib/build/run-diagnostics';
import { catalogText, hasCatalogKey, CATALOG_LOCALES } from '@core/testing/catalog-text';

const byId = (checks: Check[], id: Check['id']) => checks.find((c) => c.id === id)!;

const okRun: DiagRun = {
  ok: true,
  path: ['a', 'b'],
  output: 'Here are the recommended budget moves: ...',
  nodes: [
    { node: 'a', status: 'ok', steps: [{ tool: 'query_data' }] },
    { node: 'b', status: 'ok', steps: [{ tool: 'search_knowledge' }] },
  ],
};

test('a clean run passes all three checks', () => {
  const checks = runChecks(okRun);
  assert.equal(checks.length, 3);
  assert.ok(allChecksPass(checks));
  for (const c of checks) assert.ok(c.pass, `${c.id} should pass`);
});

test('empty output fails the output check only', () => {
  const checks = runChecks({ ...okRun, output: '   ' });
  assert.equal(byId(checks, 'output').pass, false);
  assert.equal(byId(checks, 'clean').pass, true);
  assert.equal(byId(checks, 'budget').pass, true);
  assert.equal(allChecksPass(checks), false);
});

test('missing output field fails the output check', () => {
  const checks = runChecks({ ...okRun, output: undefined });
  assert.equal(byId(checks, 'output').pass, false);
});

test('a denied tool step fails the clean check with a count', () => {
  const run: DiagRun = {
    ...okRun,
    nodes: [{ node: 'a', status: 'ok', steps: [{ tool: 'write_data', isError: true, errorKind: 'policy' }] }],
  };
  const clean = byId(runChecks(run), 'clean');
  assert.equal(clean.pass, false);
  assert.match(clean.detail, /denied/);
});

test('an errored tool step fails the clean check', () => {
  const run: DiagRun = {
    ...okRun,
    nodes: [{ node: 'a', status: 'error', steps: [{ tool: 'query_data', isError: true, errorKind: 'exec' }] }],
  };
  assert.equal(byId(runChecks(run), 'clean').pass, false);
});

test('a failed node names the agent in the detail', () => {
  const run: DiagRun = { ...okRun, nodes: [{ node: 'planner', status: 'failed', steps: [] }] };
  const clean = byId(runChecks(run), 'clean');
  assert.equal(clean.pass, false);
  assert.match(clean.detail, /planner/);
});

test('hitting the tool-step cap fails the budget check', () => {
  const run: DiagRun = { ...okRun, output: 'Stopped: reached the tool-step budget for this agent.' };
  const budget = byId(runChecks(run), 'budget');
  assert.equal(budget.pass, false);
  // But it still has output and clean nodes.
  assert.equal(byId(runChecks(run), 'output').pass, true);
});

// ---------------------------------------------------------------- i18n --

/** Runs that exercise every label and detail sentence. */
const i18nRuns: DiagRun[] = [
  okRun,
  { ...okRun, output: '' },
  { ...okRun, nodes: [{ node: 'a', status: 'failed', steps: [] }] },
  { ...okRun, nodes: [{ node: 'a', status: 'ok', steps: [{ tool: 'x', isError: true, errorKind: 'policy' }] }] },
  { ...okRun, nodes: [{ node: 'a', status: 'ok', steps: [{ tool: 'x', isError: true, errorKind: 'policy' }, { tool: 'y', isError: true, errorKind: 'exec' }] }] },
  { ...okRun, output: 'Stopped: reached the tool-step budget.' },
];

test('i18n: labelKey and detailMsg render through the English catalog to exactly label and detail', () => {
  for (const run of i18nRuns) {
    for (const c of runChecks(run)) {
      assert.equal(catalogText('agents', { key: c.labelKey }), c.label);
      assert.equal(catalogText('agents', c.detailMsg), c.detail);
    }
  }
});

test('i18n: every check key exists in all seven languages', () => {
  for (const run of i18nRuns) {
    for (const c of runChecks(run)) {
      for (const locale of CATALOG_LOCALES) {
        assert.ok(hasCatalogKey('agents', c.labelKey, locale), `${locale}: ${c.labelKey}`);
        assert.ok(hasCatalogKey('agents', c.detailMsg.key, locale), `${locale}: ${c.detailMsg.key}`);
        assert.ok(catalogText('agents', c.detailMsg, locale).length > 0);
      }
    }
  }
});

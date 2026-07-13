/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnostics,
  buildRunReport,
  diagnosticsTable,
  reportFilename,
  shapeTraceMetrics,
  totalCalls,
  type DiagRun,
} from './run-diagnostics.ts';

const sampleRun: DiagRun = {
  ok: true,
  path: ['analyst', 'recommender'],
  mode: 'live',
  output: 'Shift 20% of budget from Search to Social.',
  nodes: [
    {
      node: 'analyst',
      model: 'openai/gpt-oss-20b',
      tier: 'fast',
      status: 'ok',
      finalText: 'Search ROAS is falling; Social is climbing.',
      steps: [
        { tool: 'query_data', isError: false },
        { tool: 'query_metric', isError: false },
        { tool: 'promote', isError: true, errorKind: 'policy' },
      ],
    },
    {
      node: 'recommender',
      model: 'openai/gpt-oss-120b',
      tier: 'reasoning',
      status: 'ok',
      finalText: 'Recommend a 20% shift.',
      steps: [
        { tool: 'query_data', isError: false },
        { tool: 'author_knowledge', isError: true, errorKind: 'exec' },
      ],
    },
  ],
};

test('totalCalls sums per-node steps, falling back to the flat step list', () => {
  assert.equal(totalCalls(sampleRun), 5);
  assert.equal(
    totalCalls({ ok: true, path: [], steps: [{ node: 'a', tool: 't', effect: 'allow' }] }),
    1,
  );
  assert.equal(totalCalls({ ok: true, path: [] }), 0);
});

test('buildDiagnostics produces one row per node with denied/error counts + honest totals', () => {
  const diag = buildDiagnostics(sampleRun);
  assert.equal(diag.rows.length, 2);
  assert.equal(diag.traceMetricsAvailable, false);

  const analyst = diag.rows[0];
  assert.equal(analyst.agent, 'analyst');
  assert.equal(analyst.calls, 3);
  assert.equal(analyst.denied, 1); // policy block
  assert.equal(analyst.errors, 0);
  assert.equal(analyst.tokens, undefined); // no trace metrics → omitted

  const rec = diag.rows[1];
  assert.equal(rec.errors, 1); // exec error, not a denial
  assert.equal(rec.denied, 0);

  assert.deepEqual(diag.totals, { nodes: 2, calls: 5, denied: 1, errors: 1 });
});

test('buildDiagnostics merges Langfuse metrics when available', () => {
  const metrics = shapeTraceMetrics(
    [
      { metadata: { node: 'analyst' }, usage: { total: 1000 }, latency: 1.5, calculatedTotalCost: 0.002 },
      { name: 'agent.query_data recommender', usage: { total: 500 }, latency: 0.5, calculatedTotalCost: 0.001 },
    ],
    ['analyst', 'recommender'],
  );
  assert.equal(metrics.available, true);
  assert.equal(metrics.totals.tokens, 1500);
  assert.equal(metrics.perNode.analyst.tokens, 1000);
  assert.equal(metrics.perNode.recommender.tokens, 500);

  const diag = buildDiagnostics(sampleRun, metrics);
  assert.equal(diag.traceMetricsAvailable, true);
  assert.equal(diag.rows[0].tokens, 1000);
  assert.equal(diag.rows[0].latencyMs, 1500); // seconds → ms
  assert.equal(diag.totals.tokens, 1500);
});

test('shapeTraceMetrics degrades honestly on an empty / non-array read', () => {
  const empty = shapeTraceMetrics([], ['analyst']);
  assert.equal(empty.available, false);
  assert.equal(empty.totals.tokens, 0);
  // @ts-expect-error deliberately wrong shape
  assert.equal(shapeTraceMetrics(null, []).available, false);
});

test('shapeTraceMetrics tolerates missing fields without throwing (defensive)', () => {
  const m = shapeTraceMetrics([{}, { usage: null, metadata: null }], ['analyst']);
  assert.equal(m.available, true); // rows existed
  assert.equal(m.totals.tokens, 0);
  assert.equal(m.totals.costUsd, 0);
});

test('diagnosticsTable omits metric columns when unavailable and includes them when present', () => {
  const bare = diagnosticsTable(buildDiagnostics(sampleRun));
  assert.deepEqual(bare.head, ['Agent', 'Model / tier', 'Calls', 'Decision']);
  assert.equal(bare.rows.length, 2);
  assert.match(bare.rows[0][3], /ok \(1 denied\)/);
  assert.equal(bare.totals[0], 'Total');

  const metrics = shapeTraceMetrics([{ metadata: { node: 'analyst' }, usage: { total: 10 } }], ['analyst']);
  const rich = diagnosticsTable(buildDiagnostics(sampleRun, metrics));
  assert.deepEqual(rich.head.slice(4), ['Tokens', 'Latency', 'Cost']);
});

test('buildRunReport maps a run into a non-empty, legible report', () => {
  const diag = buildDiagnostics(sampleRun);
  const report = buildRunReport(sampleRun, diag, {
    systemName: 'Campaign Analyst',
    ranBy: 'alex',
    at: Date.UTC(2026, 6, 13, 9, 30),
    prompt: 'Review last month and recommend moves',
  });
  assert.equal(report.title, 'Campaign Analyst');
  assert.equal(report.ranBy, 'alex');
  assert.match(report.summary, /Completed · 5 governed calls across 2 agents/);
  assert.equal(report.agents.length, 2);
  assert.equal(report.agents[0].output, 'Search ROAS is falling; Social is climbing.');
  assert.equal(report.finalOutput, 'Shift 20% of budget from Search to Social.');
  assert.ok(report.table.rows.length === 2);
  assert.match(report.path, /analyst → recommender → END/);
});

test('buildRunReport fills sensible placeholders for an empty prompt / output', () => {
  const run: DiagRun = { ok: true, path: [], nodes: [] };
  const report = buildRunReport(run, buildDiagnostics(run), { systemName: '', ranBy: '', at: 0, prompt: '  ' });
  assert.equal(report.title, 'Agent run');
  assert.equal(report.ranBy, 'unknown');
  assert.equal(report.prompt, '(default task)');
  assert.equal(report.finalOutput, '(the run produced no final text)');
});

test('reportFilename is filesystem-safe and time-stamped', () => {
  const fn = reportFilename('Campaign Analyst!', Date.UTC(2026, 6, 13, 9, 30));
  assert.match(fn, /^run-campaign-analyst-2026-07-13T09-30\.pdf$/);
  assert.equal(reportFilename('', 0).startsWith('run-run-'), true);
});

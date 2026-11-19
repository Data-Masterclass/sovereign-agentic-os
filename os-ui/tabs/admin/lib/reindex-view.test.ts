/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Re-index panel's copy and disabled-state, under test
 * USER STORY: As a platform admin I must never be shown a Run button that would fail, a disabled
 *             control with no reason, or a counts table that lets me read "marked: 0" as "clean".
 * ARCHITECTURE:
 *   - The panel is a `.tsx` the harness cannot import, so every sentence and every predicate it
 *     renders lives in the `.ts` sibling and is asserted here (the `sections.ts` pattern).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKED_VS_ALL_COPY,
  REASON_HELP,
  REASON_LABELS,
  REINDEX_TARGET_VIEWS,
  engineLines,
  progressLabel,
  reasonRows,
  runButtonLabel,
  runDisabledReason,
} from '@tabs/admin/lib/reindex-view';
import { REINDEX_REASONS, type ReindexJob, type ReindexPlan } from '@core/kernel/reindex';

function plan(over: Partial<ReindexPlan> = {}): ReindexPlan {
  return {
    target: 'files',
    filter: 'marked',
    counts: { marked: 4, 'missing-representation': 1, 'missing-vector': 2, 'dimension-mismatch': 0, all: 40 },
    units: [{ id: 'f1', label: 'a.pdf', reasons: ['marked'], rows: 4 }],
    rowsTotal: 40,
    mappingDim: 384,
    configuredDim: 384,
    engines: [
      { name: 'Docling (document parser)', url: 'http://docling:5001/health', ready: true, detail: null },
      { name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: true, detail: null },
    ],
    ready: true,
    blockedReason: null,
    unmarkedCaveat: 'caveat',
    truncated: false,
    ...over,
  };
}

function job(over: Partial<ReindexJob> = {}): ReindexJob {
  return {
    id: 'rix_1', target: 'files', filter: 'marked', status: 'running',
    total: 10, cursor: 3, replaced: 2, failed: 1, skipped: 0,
    startedAt: 'x', updatedAt: 'x', finishedAt: null, by: 'u_admin', failures: [], error: null,
    ...over,
  };
}

test('REINDEX PANEL: both corpora are offered, and each says what it will actually do', () => {
  assert.deepEqual(REINDEX_TARGET_VIEWS.map((t) => t.id), ['files', 'knowledge']);
  assert.match(REINDEX_TARGET_VIEWS[0].sub, /Docling/);
  assert.match(REINDEX_TARGET_VIEWS[1].sub, /re-embeds/);
});

test('REINDEX PANEL: the marked-vs-all copy says the thing an operator must not get wrong', () => {
  assert.match(MARKED_VS_ALL_COPY, /not a clean bill of health/);
  assert.match(MARKED_VS_ALL_COPY, /same bytes in the same field/);
  assert.match(MARKED_VS_ALL_COPY, /only\s+complete answer/);
});

test('REINDEX PANEL: every reason has a label and help, and the table shows all of them', () => {
  for (const r of REINDEX_REASONS) {
    assert.ok(REASON_LABELS[r], `${r} has a label`);
    assert.ok(REASON_HELP[r], `${r} explains itself`);
  }
  const rows = reasonRows(plan());
  assert.deepEqual(rows.map((r) => r.reason), [...REINDEX_REASONS], 'fixed order, nothing omitted at zero');
  assert.equal(rows.find((r) => r.reason === 'dimension-mismatch')!.count, 0);
  assert.equal(rows.find((r) => r.reason === 'missing-representation')!.unit, 'units', 'the one count that is not rows');
  assert.equal(rows.find((r) => r.reason === 'marked')!.unit, 'rows');
  assert.match(REASON_HELP.marked, /0 here is expected and proves nothing/);
});

test('REINDEX PANEL: Run is disabled before a Plan, and says why', () => {
  const why = runDisabledReason(null, null);
  assert.match(why!, /Run Plan first/);
});

test('REINDEX PANEL: Run is disabled while an engine is down, naming the component', () => {
  const why = runDisabledReason(
    plan({ ready: false, blockedReason: 'Docling (document parser) is not reachable at http://docling:5001/health — HTTP 502.' }),
    null,
  );
  assert.match(why!, /Docling/);
  assert.match(why!, /HTTP 502/);
});

test('REINDEX PANEL: Run is disabled when the filter selected nothing', () => {
  assert.match(runDisabledReason(plan({ units: [] }), null)!, /Nothing selected/);
});

test('REINDEX PANEL: a run already in flight is continued, never restarted', () => {
  const why = runDisabledReason(plan(), job());
  assert.match(why!, /already running \(3\/10 done\)/);
  assert.match(why!, /Continue it instead/);
  assert.equal(runButtonLabel(job()), 'Continue (3/10)');
  assert.equal(runButtonLabel(null), 'Run re-index');
  assert.equal(runButtonLabel(job({ status: 'done' })), 'Run re-index');
});

test('REINDEX PANEL: a ready plan with units enables Run — and only then', () => {
  assert.equal(runDisabledReason(plan(), null), null);
  assert.match(runDisabledReason(plan(), null, true)!, /in flight/);
});

test('REINDEX PANEL: progress is honest about failures and about what is left', () => {
  assert.equal(progressLabel(null), 'Not run yet.');
  assert.match(progressLabel(job()), /Running — 3 of 10 done, 7 to go: 2 replaced · 1 failed\./);
  assert.match(progressLabel(job({ status: 'done', cursor: 10, replaced: 9, failed: 1 })), /Finished — 10 of 10 units/);
  assert.match(progressLabel(job({ status: 'failed' })), /Stopped — 3 of 10 units, then it failed/);
  assert.match(progressLabel(job({ failed: 0, skipped: 2 })), /2 replaced · 2 skipped/);
});

test('REINDEX PANEL: the engine rows state reachability in the operator’s words', () => {
  assert.deepEqual(engineLines(null), [], 'nothing claimed before a probe');
  const lines = engineLines(
    plan({
      engines: [
        { name: 'Docling (document parser)', url: 'http://docling:5001/health', ready: false, detail: 'ECONNREFUSED' },
        { name: 'embeddings gateway (LiteLLM)', url: 'http://litellm:4000/health/liveliness', ready: true, detail: null },
      ],
    }),
  );
  assert.equal(lines[0].ok, false);
  assert.match(lines[0].text, /NOT reachable at http:\/\/docling:5001\/health — ECONNREFUSED/);
  assert.equal(lines[1].ok, true);
  assert.match(lines[1].text, /reachable at/);
});

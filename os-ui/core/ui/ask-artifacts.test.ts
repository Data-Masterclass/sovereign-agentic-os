/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_CHAR_CAP,
  VIEW_ROW_CAP,
  citationDetail,
  citationHref,
  citationLabel,
  clampCell,
  dedupeCitations,
  deferredNote,
  splitArtifacts,
  tableView,
} from '@core/ui/ask-artifacts';
import { askTurnResponse } from '@core/runtime/ask-response';
import { citationArtifact, tableArtifact, type ChatArtifact } from '@core/runtime/chat-artifacts';

/**
 * FEATURE:    The drawer's `table` + `citation` rendering decisions, and the turn payload (C9).
 *
 * USER STORY: As a user I must never see a confident number over a clipped result, and I
 *             must be able to tell an ad-hoc SQL answer from the governed metric.
 *
 * ARCHITECTURE:
 *   All of it is pure, in `.ts`, because a test cannot import the `.tsx` shell that mounts
 *   it. The ONE property these tests exist to defend: BOTH truncations stay separate and
 *   both stay visible — the backend's verbatim sentence and this view's own row cap. A
 *   single merged "showing 50 rows" line would let a 50-row view read as a 50-row result.
 */

const CLIPPED = {
  columns: ['region', 'total'],
  rows: Array.from({ length: 120 }, (_, i) => [`r${i}`, String(i)]),
  rowCount: 1000,
  truncated: true,
  rowLimit: 1000,
  message: 'Result clipped at QUERY_MAX_ROWS=1000. These are the first 1000 rows, not a sample.',
};

// ---------------------------------------------------------------- table view ----

test('C5: the view shows the backend truncation sentence VERBATIM, above the rows', () => {
  const v = tableView(tableArtifact(CLIPPED, { source: 'ad-hoc-sql', sql: 'select 1' }));
  assert.equal(v.banner, CLIPPED.message, 'the backend sentence must not be paraphrased or merged');
});

test('C5: the view clip and the BACKEND clip are reported separately, never merged', () => {
  const v = tableView(tableArtifact(CLIPPED, { source: 'ad-hoc-sql' }));
  assert.ok(v.banner, 'the backend clip is its own line');
  assert.ok(v.viewNote, "this view's own cap is its own line");
  assert.notEqual(v.banner, v.viewNote);
  assert.equal(v.rows.length, VIEW_ROW_CAP);
  assert.equal(v.viewClipped, true);
  // The authoritative size stays the tool's count, not what the view showed.
  assert.equal(v.rowCount, 1000);
  assert.match(v.viewNote ?? '', /first 50 of the 120 rows/);
});

test('C5: a whole result produces NO banner and NO view note — silence means nothing was cut', () => {
  const v = tableView(tableArtifact({ columns: ['a'], rows: [['1']], rowCount: 1 }, { source: 'semantic-layer' }));
  assert.equal(v.banner, null);
  assert.equal(v.viewNote, null);
  assert.equal(v.viewClipped, false);
});

test('C6: an ad-hoc SQL answer is labelled unverified and carries the caveat', () => {
  const v = tableView(tableArtifact(CLIPPED, { source: 'ad-hoc-sql', sql: 'select 1' }));
  assert.match(v.sourceLabel, /Ad hoc SQL/);
  assert.match(v.sourceLabel, /unverified/i);
  assert.ok(v.sourceCaveat && /not from a governed metric definition/.test(v.sourceCaveat));
  assert.equal(v.sql, 'select 1', 'an ad-hoc answer must always show the SQL it ran');
});

test('C6: a semantic-layer answer is labelled governed and carries NO unverified caveat', () => {
  const v = tableView(
    tableArtifact({ columns: ['a'], rows: [['1']], rowCount: 1 }, { source: 'semantic-layer', mode: 'live' }),
  );
  assert.match(v.sourceLabel, /Governed metric/);
  assert.equal(v.sourceCaveat, null);
  assert.equal(v.mode, 'live', 'the resolver mode is shown so offline-mock can never pass as live');
});

test('C5: an offline-mock resolver mode is carried through to the view, never hidden', () => {
  const v = tableView(
    tableArtifact({ columns: ['a'], rows: [['1']], rowCount: 1 }, { source: 'semantic-layer', mode: 'offline-mock' }),
  );
  assert.equal(v.mode, 'offline-mock');
});

test('C10: a cell is clamped as TEXT and the clamp is visible, never a silent cut', () => {
  const long = 'x'.repeat(CELL_CHAR_CAP + 50);
  const { text, clamped } = clampCell(long);
  assert.equal(clamped, true);
  assert.equal(text.length, CELL_CHAR_CAP + 1);
  assert.ok(text.endsWith('…'));
  assert.equal(clampCell('short').clamped, false);
  assert.equal(clampCell('short').text, 'short');
});

test('C10: markup in a cell stays a literal string — the view never interprets a value', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const v = tableView(tableArtifact({ columns: ['c'], rows: [[evil]], rowCount: 1 }, { source: 'ad-hoc-sql' }));
  assert.equal(v.rows[0][0], evil, 'the value is passed through untouched, to be rendered as a text node');
  assert.equal(clampCell(evil).text, evil);
});

// ------------------------------------------------------------------ citations ----

test('C9: a citation chip links through the fixed in-app route map, never a model href', () => {
  assert.equal(citationHref(citationArtifact('dataset', 'ds_1')), '/data');
  assert.equal(citationHref(citationArtifact('metric', 'ds_1.rev')), '/metrics');
  assert.equal(citationHref(citationArtifact('dashboard', 'dash_1')), '/dashboards');
});

test('C9: the chip names the governed record, falling back to the id, never to nothing', () => {
  assert.equal(citationLabel(citationArtifact('metric', 'ds_1.rev', { name: 'Revenue' })), 'KPI: Revenue');
  assert.equal(citationLabel(citationArtifact('metric', 'ds_1.rev')), 'KPI: ds_1.rev');
  assert.equal(citationLabel(citationArtifact('dataset', 'ds_1', { name: 'orders' })), 'Data product: orders');
});

test('C9: tier, owner and freshness show when the governed record carried them', () => {
  assert.equal(citationDetail(citationArtifact('metric', 'm', { tier: 'domain', owner: 'u-42' })), 'domain · owner u-42');
  assert.equal(citationDetail(citationArtifact('metric', 'm')), null);
});

test('C9: duplicate citations collapse, keeping the richest copy and first-seen order', () => {
  const list = [
    citationArtifact('dataset', 'ds_1'),
    citationArtifact('metric', 'ds_1.rev', { name: 'Revenue', tier: 'domain' }),
    citationArtifact('dataset', 'ds_1', { name: 'orders', tier: 'product', owner: 'u-7' }),
  ];
  const out = dedupeCitations(list);
  assert.equal(out.length, 2);
  assert.equal(out[0].of, 'dataset');
  assert.equal(out[0].name, 'orders', 'the richer copy must win, regardless of order');
  assert.equal(out[1].id, 'ds_1.rev');
});

// --------------------------------------------------------------------- split ----

test('C9: the split routes tables and citations to their renderers', () => {
  const artifacts: ChatArtifact[] = [
    tableArtifact({ columns: [], rows: [], rowCount: 0 }, { source: 'ad-hoc-sql' }),
    citationArtifact('metric', 'm'),
    citationArtifact('metric', 'm'),
  ];
  const { tables, citations, deferred } = splitArtifacts(artifacts);
  assert.equal(tables.length, 1);
  assert.equal(citations.length, 1, 'duplicates collapse in the split too');
  assert.equal(deferred.length, 0);
});

test('C9: a kind this build cannot render is COUNTED, never silently discarded', () => {
  const artifacts: ChatArtifact[] = [
    { kind: 'chart', view: 'V', panel: {} },
    { kind: 'chart', view: 'V', panel: {} },
    { kind: 'metric_draft', datasetId: 'ds', form: {} },
  ];
  const { deferred } = splitArtifacts(artifacts);
  assert.equal(deferred.length, 3);
  const note = deferredNote(deferred) ?? '';
  assert.match(note, /2 charts/);
  assert.match(note, /1 metric draft/);
  assert.match(note, /does not render them yet/);
  assert.equal(deferredNote([]), null);
});

// ----------------------------------------------------------- the turn payload ----

test('C9: the turn returns artifacts BESIDE content and tools, always as an array', () => {
  const res = askTurnResponse({
    finalText: 'Revenue was €128,450 last month.',
    plan: '1. list_metrics',
    steps: [{ tool: 'query_metric', isError: false }],
    artifacts: [tableArtifact(CLIPPED, { source: 'ad-hoc-sql' }), citationArtifact('metric', 'ds_1.rev')],
    tab: 'metrics',
    traceId: 'ask-1',
    model: 'sovereign-default',
  });
  assert.equal(res.content, 'Revenue was €128,450 last month.');
  assert.deepEqual(res.tools, [{ name: 'query_metric', isError: false }]);
  assert.equal(res.artifacts.length, 2);
  assert.equal(res.traceId, 'ask-1');
  // Total shape: no client branch for "old response".
  assert.deepEqual(Object.keys(res).sort(), ['artifacts', 'content', 'model', 'plan', 'role', 'tab', 'tools', 'traceId']);
});

test('C9/C5: the route re-validates, and the truncation fields survive to the client', () => {
  const res = askTurnResponse({
    finalText: 'x',
    plan: '',
    steps: [],
    artifacts: [tableArtifact(CLIPPED, { source: 'ad-hoc-sql' })],
    tab: null,
    traceId: 'ask-2',
    model: 'm',
  });
  const t = res.artifacts[0];
  assert.ok(t.kind === 'table' && t.truncated === true && t.rowLimit === 1000);
  assert.equal(t.kind === 'table' && t.message, CLIPPED.message);
});

test('C9: a turn with no artifacts returns an empty array, never an absent field', () => {
  const res = askTurnResponse({ finalText: 'hi', plan: '', steps: [], artifacts: [], tab: null, traceId: 't', model: 'm' });
  assert.deepEqual(res.artifacts, []);
});

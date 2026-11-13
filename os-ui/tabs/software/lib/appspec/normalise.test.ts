/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       tabs/software
 * FEATURE:    Tests for the tolerant pre-validation shape normaliser
 * USER STORY: As a maintainer I want proof that a bare metric id builds (with a note), that the
 *             canonical shape is untouched, and that genuine nonsense is STILL rejected with the
 *             same message — so the tolerant stage can never quietly widen the grammar.
 * ARCHITECTURE:
 *   - node:test + node:assert/strict. Imports only the pure modules (no .tsx, no route, no store).
 *   - Covers the normaliser directly AND through parseGeneratedSpec (the production path).
 */
/**
 * normalise.test — TOLERANT PARSE, STRICT OUTPUT.
 *
 * The production bug: the build assistant returned `"metric": "m_revenue"` (a bare id) and the
 * structural gate killed the whole build with `metric must be an object / use { metricId }`.
 * `normaliseSpecShapes` folds the unambiguous shapes into the canonical grammar BEFORE the gate
 * and records each rewrite as a note; the gate itself stays strict, so the STORED spec is always
 * canonical and genuine nonsense is still rejected with the SAME message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSpecShapes } from './normalise.ts';
import { parseGeneratedSpec } from './generate.ts';

/** A spec whose single kpi-overview card sources `metric` the way the caller passes it. */
function specWithMetric(metric: unknown): Record<string, unknown> {
  return {
    version: 2,
    name: 'Revenue',
    description: '',
    tabs: [
      {
        id: 't1',
        label: 'KPIs',
        body: {
          kind: 'pattern',
          pattern: 'kpi-overview',
          config: { cards: [{ label: 'Revenue', metric }] },
        },
      },
    ],
  };
}

// ----------------------------------------------------------------- rule 1: bare id string --

test('a bare metric id becomes { metricId } and is noted', () => {
  const { value, notes } = normaliseSpecShapes({ metric: 'm_revenue' });
  assert.deepEqual(value, { metric: { metricId: 'm_revenue' } });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /normalised metric id → \{ metricId \}/);
  assert.match(notes[0], /metric/);
});

test('bare ids are normalised DEEP inside a spec, with the path in the note', () => {
  const { value, notes } = normaliseSpecShapes(specWithMetric('m_revenue'));
  const cards = (((value as Record<string, unknown>).tabs as Record<string, unknown>[])[0].body as Record<string, unknown>)
    .config as { cards: { metric: unknown }[] };
  assert.deepEqual(cards.cards[0].metric, { metricId: 'm_revenue' });
  assert.match(notes[0], /tabs\[0\]\.body\.config\.cards\[0\]\.metric/);
});

test('the sibling single-key slots normalise the same way', () => {
  const { value, notes } = normaliseSpecShapes({
    metric: 'm_1',
    function: 'f_1',
    source: 'ds_1',
  });
  assert.deepEqual(value, {
    metric: { metricId: 'm_1' },
    function: { functionId: 'f_1' },
    source: { datasetId: 'ds_1' },
  });
  assert.equal(notes.length, 3);
});

test('source:"records" is REAL grammar and is left alone', () => {
  const { value, notes } = normaliseSpecShapes({ source: 'records', titleField: 'task' });
  assert.deepEqual(value, { source: 'records', titleField: 'task' });
  assert.deepEqual(notes, []);
});

test('an empty-string id is NOT invented into an object (the gate must report it)', () => {
  const { value, notes } = normaliseSpecShapes({ metric: '' });
  assert.deepEqual(value, { metric: '' });
  assert.deepEqual(notes, []);
});

test('a bare id for a MULTI-key slot is not completed (agg cannot be invented)', () => {
  const { value, notes } = normaliseSpecShapes({ dataset: 'ds_1' });
  assert.deepEqual(value, { dataset: 'ds_1' });
  assert.deepEqual(notes, []);
});

// ------------------------------------------------------------------- rule 2: { id } rename --

test('{ id } is renamed to the canonical id key', () => {
  const { value, notes } = normaliseSpecShapes({ metric: { id: 'm_revenue' } });
  assert.deepEqual(value, { metric: { metricId: 'm_revenue' } });
  assert.match(notes[0], /normalised metric\.id → metric\.metricId/);
});

test('the { id } rename preserves every sibling key, including multi-key slots', () => {
  const { value, notes } = normaliseSpecShapes({
    dataset: { id: 'ds_1', agg: 'sum', field: 'amount' },
    assignTo: { id: 'ds_people', optionLabelField: 'name' },
  });
  assert.deepEqual(value, {
    dataset: { datasetId: 'ds_1', agg: 'sum', field: 'amount' },
    assignTo: { datasetId: 'ds_people', optionLabelField: 'name' },
  });
  assert.equal(notes.length, 2);
});

test('a canonical slot that ALSO carries an id keeps the canonical key untouched', () => {
  const { value, notes } = normaliseSpecShapes({ metric: { metricId: 'm_1', id: 'ignored' } });
  assert.deepEqual(value, { metric: { metricId: 'm_1', id: 'ignored' } });
  assert.deepEqual(notes, []);
});

// --------------------------------------------------------------------- passthrough / scope --

test('an already-canonical spec passes through unchanged with NO notes', () => {
  const spec = specWithMetric({ metricId: 'm_revenue' });
  const { value, notes } = normaliseSpecShapes(spec);
  assert.deepEqual(value, spec);
  assert.deepEqual(notes, []);
});

test('non-reference fields are never touched', () => {
  const input = {
    version: 2,
    name: 'App',
    description: 'A description with the word metric in it.',
    theme: { css: '.x{}' },
    tabs: [
      {
        id: 't1',
        label: 'Tasks',
        icon: '✅',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: {
            source: { datasetId: 'ds_1' },
            columns: [{ field: 'metric', label: 'Metric', format: 'text' }],
            search: true,
            pageSize: 25,
          },
        },
      },
    ],
  };
  const { value, notes } = normaliseSpecShapes(input);
  assert.deepEqual(value, input);
  assert.deepEqual(notes, []);
});

test('the input is not mutated', () => {
  const input = { metric: 'm_1' };
  normaliseSpecShapes(input);
  assert.deepEqual(input, { metric: 'm_1' });
});

test('a non-object input passes through (parseAppSpec owns that refusal)', () => {
  assert.deepEqual(normaliseSpecShapes('nope'), { value: 'nope', notes: [] });
  assert.deepEqual(normaliseSpecShapes(null), { value: null, notes: [] });
});

// ------------------------------------------------- through the gate: the production scenario --

test('parseGeneratedSpec now ACCEPTS a bare metric id and reports the normalisation', () => {
  const r = parseGeneratedSpec(JSON.stringify(specWithMetric('m_revenue')));
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.spec.tabs[0].body, {
    kind: 'pattern',
    pattern: 'kpi-overview',
    config: { cards: [{ label: 'Revenue', metric: { metricId: 'm_revenue' } }] },
  });
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /normalised metric id → \{ metricId \}/);
});

test('parseGeneratedSpec accepts the { id } variant too', () => {
  const r = parseGeneratedSpec(JSON.stringify(specWithMetric({ id: 'm_revenue' })));
  assert.ok(r.ok);
  assert.match(r.notes[0], /normalised metric\.id → metric\.metricId/);
});

test('nonsense is STILL rejected with the SAME message (the gate stays strict)', () => {
  const r = parseGeneratedSpec(JSON.stringify(specWithMetric(42)));
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  const issue = r.issues.find((i) => i.reason === 'metric must be an object');
  assert.ok(issue, `expected the unchanged structural issue, got ${JSON.stringify(r.issues)}`);
  assert.equal(issue.fix, 'use { metricId }');
  assert.equal(issue.path, 'tabs[0].body.config.cards[0].metric');
  assert.deepEqual(r.notes, []);
});

test('a canonical spec through the gate reports no notes', () => {
  const r = parseGeneratedSpec(JSON.stringify(specWithMetric({ metricId: 'm_revenue' })));
  assert.ok(r.ok);
  assert.deepEqual(r.notes, []);
});

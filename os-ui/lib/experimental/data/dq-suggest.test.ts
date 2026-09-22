/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestChecks, describeSuggestion, type SuggestedCheck } from './dq-suggest.ts';
import type { ColumnProfile, Profile } from './profile.ts';
import type { DataCheck } from './dataset-schema.ts';

function col(over: Partial<ColumnProfile> & { name: string }): ColumnProfile {
  return {
    name: over.name,
    type: over.type ?? 'varchar',
    kind: over.kind ?? 'string',
    nulls: over.nulls ?? 0,
    nullPct: over.nullPct ?? 0,
    distinct: over.distinct ?? 0,
    min: over.min ?? null,
    max: over.max ?? null,
    top: over.top ?? [],
  };
}

function profile(rowCount: number, columns: ColumnProfile[]): Profile {
  return {
    fqn: 'iceberg.sales.gold_orders',
    layer: 'gold',
    rowCount,
    columns,
    preview: { columns: [], rows: [] },
    generatedAt: '',
  };
}

test('0 nulls over a non-empty table ⇒ not_null with cited evidence', () => {
  const s = suggestChecks(profile(100, [col({ name: 'order_id', nulls: 0, distinct: 50 })]));
  const nn = s.find((x) => x.rule === 'not_null');
  assert.ok(nn, 'not_null suggested');
  assert.equal(nn!.column, 'order_id');
  assert.match(nn!.evidence, /0 nulls in 100 rows/);
});

test('~100% distinct ⇒ unique', () => {
  const s = suggestChecks(profile(100, [col({ name: 'order_id', nulls: 0, distinct: 100 })]));
  const u = s.find((x) => x.rule === 'unique');
  assert.ok(u, 'unique suggested');
  assert.match(u!.evidence, /100 of 100 distinct/);
});

test('a column with nulls is NOT suggested not_null, and low-distinct is NOT unique', () => {
  const s = suggestChecks(profile(100, [col({ name: 'note', nulls: 5, distinct: 3 })]));
  assert.equal(s.find((x) => x.rule === 'not_null'), undefined);
  assert.equal(s.find((x) => x.rule === 'unique'), undefined);
});

test('a small closed category set ⇒ accepted_values with the observed values', () => {
  const s = suggestChecks(profile(100, [
    col({ name: 'status', kind: 'string', nulls: 0, distinct: 3, top: [
      { value: 'new', count: 40 }, { value: 'paid', count: 40 }, { value: 'shipped', count: 20 },
    ] }),
  ]));
  const av = s.find((x) => x.rule === 'accepted_values');
  assert.ok(av, 'accepted_values suggested');
  assert.deepEqual(av!.values, ['new', 'paid', 'shipped']);
  assert.match(av!.evidence, /3 categories seen/);
});

test('a high-cardinality string is NOT an enum (no accepted_values)', () => {
  const s = suggestChecks(profile(1000, [
    col({ name: 'email', kind: 'string', nulls: 0, distinct: 950, top: [{ value: 'a@x', count: 1 }] }),
  ]));
  assert.equal(s.find((x) => x.rule === 'accepted_values'), undefined);
});

test('a numeric column with observed min/max ⇒ range', () => {
  const s = suggestChecks(profile(100, [
    col({ name: 'amount', kind: 'numeric', type: 'double', nulls: 0, distinct: 80, min: '0', max: '1000' }),
  ]));
  const r = s.find((x) => x.rule === 'range');
  assert.ok(r, 'range suggested');
  assert.equal(r!.min, 0);
  assert.equal(r!.max, 1000);
  assert.match(r!.evidence, /observed 0–1000/);
});

test('an empty table proves nothing — no suggestions', () => {
  assert.deepEqual(suggestChecks(profile(0, [col({ name: 'x', nulls: 0, distinct: 0 })])), []);
});

// ── Deterministic descriptions: each rule kind lands with its own plain-language sentence ──

test('not_null suggestion carries a deterministic description naming the column', () => {
  const s = suggestChecks(profile(100, [col({ name: 'order_id', nulls: 0, distinct: 50 })]));
  const nn = s.find((x) => x.rule === 'not_null')!;
  assert.equal(nn.description, 'Every row must have a value in order_id — the profile found no missing values.');
});

test('unique suggestion carries a deterministic description', () => {
  const s = suggestChecks(profile(100, [col({ name: 'order_id', nulls: 0, distinct: 100 })]));
  const u = s.find((x) => x.rule === 'unique')!;
  assert.equal(u.description, 'Every value in order_id must be unique — the profile saw no duplicates.');
});

test('accepted_values suggestion carries a deterministic description listing the observed set', () => {
  const s = suggestChecks(profile(100, [
    col({ name: 'status', kind: 'string', nulls: 0, distinct: 3, top: [
      { value: 'new', count: 40 }, { value: 'paid', count: 40 }, { value: 'shipped', count: 20 },
    ] }),
  ]));
  const av = s.find((x) => x.rule === 'accepted_values')!;
  assert.equal(av.description, 'Values in status must be one of new, paid, shipped — the only categories the profile observed.');
});

test('range suggestion carries a deterministic description naming the observed bounds', () => {
  const s = suggestChecks(profile(100, [
    col({ name: 'amount', kind: 'numeric', type: 'double', nulls: 0, distinct: 80, min: '0', max: '1000' }),
  ]));
  const r = s.find((x) => x.rule === 'range')!;
  assert.equal(r.description, 'Values in amount must stay between 0 and 1000 — the observed range.');
});

test('describeSuggestion returns undefined for a kind with no honest deterministic sentence', () => {
  // not_blank is never produced by suggestChecks; the ✨ describe stage covers it.
  const notBlank: SuggestedCheck = { rule: 'not_blank', column: 'note', evidence: '' };
  assert.equal(describeSuggestion(notBlank), undefined);
  // accepted_values with no values ⇒ no filler sentence.
  const emptyEnum: SuggestedCheck = { rule: 'accepted_values', column: 'x', values: [], evidence: '' };
  assert.equal(describeSuggestion(emptyEnum), undefined);
  // range missing a bound ⇒ no filler sentence.
  const halfRange: SuggestedCheck = { rule: 'range', column: 'x', min: 0, evidence: '' };
  assert.equal(describeSuggestion(halfRange), undefined);
});

test('every suggestChecks output carries a non-empty description (accept lands documented)', () => {
  const s = suggestChecks(profile(100, [
    col({ name: 'order_id', kind: 'string', nulls: 0, distinct: 100 }),
    col({ name: 'status', kind: 'string', nulls: 0, distinct: 2, top: [{ value: 'a', count: 60 }, { value: 'b', count: 40 }] }),
    col({ name: 'amount', kind: 'numeric', type: 'double', nulls: 0, distinct: 80, min: '0', max: '9' }),
  ]));
  assert.ok(s.length > 0);
  for (const x of s) assert.ok(x.description && x.description.length > 0, `${x.rule}(${x.column}) has a description`);
});

test('BUG C: a CURATED Gold-only dataset (no bronze/silver) gets the same rule classes as ingested', () => {
  // A curated dataset composes straight to Gold — its ONLY layer is `gold`. The suggester
  // is layer-agnostic: it reads the profile of whatever built table the dq route resolved
  // (builtLayerFqn → the composed Gold), so a curated Gold profiles + suggests exactly like
  // an ingested Silver/Gold. This pins that curated is NOT a special case that returns none.
  const goldOnly = profile(300, [
    col({ name: 'service_id', kind: 'string', nulls: 0, distinct: 300 }),                    // → not_null + unique
    col({ name: 'status', kind: 'string', nulls: 0, distinct: 3, top: [
      { value: 'open', count: 120 }, { value: 'closed', count: 120 }, { value: 'pending', count: 60 },
    ] }),                                                                                     // → accepted_values
    col({ name: 'amount', kind: 'numeric', type: 'decimal(10,2)', nulls: 0, distinct: 250, min: '0', max: '9999' }), // → range
  ]);
  const s = suggestChecks(goldOnly);
  assert.ok(s.length > 0, 'curated Gold-only profiles yield rules, not an empty set');
  assert.ok(s.some((x) => x.rule === 'not_null' && x.column === 'service_id'));
  assert.ok(s.some((x) => x.rule === 'unique' && x.column === 'service_id'));
  assert.ok(s.some((x) => x.rule === 'accepted_values' && x.column === 'status'));
  assert.ok(s.some((x) => x.rule === 'range' && x.column === 'amount'));
});

test('suggestions dedupe against rules the dataset already has (Accept-all is idempotent)', () => {
  const existing: DataCheck[] = [
    { id: 'c1', name: '', description: '', createdBy: '', createdAt: '', rule: 'not_null', column: 'order_id' },
  ];
  const s = suggestChecks(
    profile(100, [col({ name: 'order_id', nulls: 0, distinct: 100 })]),
    existing,
  );
  // not_null(order_id) already exists ⇒ dropped; unique(order_id) is still new.
  assert.equal(s.find((x) => x.rule === 'not_null'), undefined);
  assert.ok(s.find((x) => x.rule === 'unique'));
});

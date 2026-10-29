/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * functions-schema.test — the STRUCTURAL grammar gate for `functions[]`. Pins: an absent/empty
 * array is clean; each kind's required slots; numeric ops require a field (count doesn't); filter
 * shape; an unparseable expression is a typed issue at author time; and typed `{path,reason,fix}`
 * issues over the tiny grammar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFunctions, type AppFunction } from './functions-schema.ts';

function ok(input: unknown): AppFunction[] {
  const r = parseFunctions(input);
  assert.ok(r.ok, `expected ok, got issues: ${JSON.stringify(r.ok ? [] : r.issues)}`);
  return r.ok ? r.functions : [];
}
function issues(input: unknown): { path: string; reason: string; fix: string }[] {
  const r = parseFunctions(input);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues;
}

test('absent / empty functions → clean empty result', () => {
  assert.deepEqual(ok(undefined), []);
  assert.deepEqual(ok([]), []);
});

test('non-array functions → a typed issue', () => {
  const is = issues({});
  assert.equal(is.length, 1);
  assert.equal(is[0].path, 'functions');
});

test('a valid aggregate (count, no field) parses', () => {
  const fns = ok([{ id: 'c', name: 'Count', description: 'row count', kind: 'aggregate', source: { datasetId: 'orders' }, op: 'count' }]);
  assert.equal(fns[0].kind, 'aggregate');
  assert.equal(fns[0].id, 'c');
});

test('a valid aggregate (sum with field + filters) parses', () => {
  const fns = ok([
    {
      id: 's',
      name: 'Sum',
      description: 'net',
      kind: 'aggregate',
      source: { datasetId: 'orders' },
      op: 'sum',
      field: 'amount',
      filters: [{ field: 'status', op: 'eq', value: 'open' }],
    },
  ]);
  const f = fns[0];
  assert.equal(f.kind, 'aggregate');
  if (f.kind === 'aggregate') {
    assert.equal(f.op, 'sum');
    assert.equal(f.field, 'amount');
    assert.deepEqual(f.filters, [{ field: 'status', op: 'eq', value: 'open' }]);
  }
});

test('numeric ops (sum/avg/min/max) REQUIRE a field; count does not', () => {
  for (const op of ['sum', 'avg', 'min', 'max']) {
    const is = issues([{ id: 'x', name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op }]);
    assert.ok(is.some((i) => i.path === 'functions[0].field'), `${op} should require a field`);
  }
});

test('unknown op / filter op → typed issue', () => {
  assert.ok(issues([{ id: 'x', name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op: 'median' }]).some((i) => i.path === 'functions[0].op'));
  assert.ok(
    issues([
      { id: 'x', name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op: 'count', filters: [{ field: 'a', op: 'contains', value: 1 }] },
    ]).some((i) => i.path === 'functions[0].filters[0].op'),
  );
});

test('filter needs field, op, and a scalar value', () => {
  assert.ok(
    issues([
      { id: 'x', name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op: 'count', filters: [{ field: 'a', op: 'eq' }] },
    ]).some((i) => i.path === 'functions[0].filters[0].value'),
  );
  assert.ok(
    issues([
      { id: 'x', name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op: 'count', filters: [{ field: 'a', op: 'eq', value: { nested: true } }] },
    ]).some((i) => i.path === 'functions[0].filters[0].value'),
  );
});

test('missing source / id / name / description → typed issues', () => {
  assert.ok(issues([{ id: 'x', name: 'x', description: 'x', kind: 'aggregate', op: 'count' }]).some((i) => i.path === 'functions[0].source'));
  assert.ok(issues([{ name: 'x', description: 'x', kind: 'aggregate', source: { datasetId: 'd' }, op: 'count' }]).some((i) => i.path === 'functions[0].id'));
});

test('a valid expression parses; refs are irrelevant to the STRUCTURAL parse', () => {
  const fns = ok([{ id: 'e', name: 'E', description: 'ratio', kind: 'expression', expr: 'fn.a / fn.b' }]);
  assert.equal(fns[0].kind, 'expression');
});

test('an unparseable expression is a typed author-time issue (no crash)', () => {
  const is = issues([{ id: 'e', name: 'E', description: 'x', kind: 'expression', expr: '1 +' }]);
  assert.ok(is.some((i) => i.path === 'functions[0].expr' && /does not parse/.test(i.reason)));
});

test('unknown kind → typed issue', () => {
  assert.ok(issues([{ id: 'e', name: 'E', description: 'x', kind: 'lambda', expr: '1' }]).some((i) => i.path === 'functions[0].kind'));
});

test('multiple functions collect ALL issues, not just the first', () => {
  const is = issues([
    { id: 'a', name: 'a', description: 'a', kind: 'aggregate', source: { datasetId: 'd' }, op: 'sum' }, // missing field
    { id: 'b', name: 'b', description: 'b', kind: 'expression', expr: '(' }, // bad expr
  ]);
  assert.ok(is.some((i) => i.path === 'functions[0].field'));
  assert.ok(is.some((i) => i.path === 'functions[1].expr'));
});

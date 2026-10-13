/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * OData V2/V4 dialect (operational-system-connections.md, Phase 4) — count param, next-link,
 * row envelope, and date literals. Pure: no network, no secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialectFor } from './dialect.ts';

test('count param: V2 $inlinecount=allpages vs V4 $count=true', () => {
  assert.deepEqual(dialectFor('V2').countParam(), { key: '$inlinecount', value: 'allpages' });
  assert.deepEqual(dialectFor('V4').countParam(), { key: '$count', value: 'true' });
});

test('V2: rows from d.results, nextLink from d.__next, count from d.__count', () => {
  const d = dialectFor('V2');
  const page = { d: { results: [{ a: 1 }, { a: 2 }], __next: 'https://host/svc/Set?$skiptoken=x', __count: '57' } };
  assert.deepEqual(d.rows(page), [{ a: 1 }, { a: 2 }]);
  assert.equal(d.nextLink(page), 'https://host/svc/Set?$skiptoken=x');
  assert.equal(d.count(page), 57);
  // Last page: no __next.
  assert.equal(d.nextLink({ d: { results: [] } }), null);
  // V2 also accepts a bare `d` array (no server paging).
  assert.deepEqual(d.rows({ d: [{ x: 1 }] }), [{ x: 1 }]);
});

test('V4: rows from value, nextLink from @odata.nextLink, count from @odata.count', () => {
  const d = dialectFor('V4');
  const page = { value: [{ a: 1 }], '@odata.nextLink': 'https://host/svc/Set?$skiptoken=y', '@odata.count': 12 };
  assert.deepEqual(d.rows(page), [{ a: 1 }]);
  assert.equal(d.nextLink(page), 'https://host/svc/Set?$skiptoken=y');
  assert.equal(d.count(page), 12);
  assert.equal(d.nextLink({ value: [] }), null);
  assert.equal(d.count({ value: [] }), null); // omitted count ⇒ null (never fabricated)
});

test('date literals: V2 datetime/datetimeoffset prefixes, V4 bare ISO', () => {
  const iso = '2026-01-15T08:30:00Z';
  const v2 = dialectFor('V2');
  // Offset type → datetimeoffset'…' (keeps the Z).
  assert.equal(v2.dateLiteral(iso, 'Edm.DateTimeOffset'), "datetimeoffset'2026-01-15T08:30:00.000Z'");
  // Plain datetime → datetime'…' (zone-less, drops the Z).
  assert.equal(v2.dateLiteral(iso, 'Edm.DateTime'), "datetime'2026-01-15T08:30:00.000'");
  // V4 → bare ISO literal.
  assert.equal(dialectFor('V4').dateLiteral(iso, 'Edm.DateTimeOffset'), '2026-01-15T08:30:00.000Z');
});

test('date literal: a non-datetime is refused (fixed alphabet, never smuggled)', () => {
  assert.throws(() => dialectFor('V4').dateLiteral("2026 OR 1=1", 'Edm.DateTimeOffset'), /not a datetime/);
});

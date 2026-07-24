/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * narrowCubeMeta: the panel builder's palette is narrowed to the caller's GOVERNED views.
 * A view the caller has no metric on is NEVER returned (even if Cube reports it), and a
 * governed view Cube doesn't yet report falls back to the registry measures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CubeMetaView } from '../infra/governed.ts';
import { narrowCubeMeta } from './cube-meta.ts';

const meta: CubeMetaView[] = [
  { name: 'Sales', measures: ['Sales.revenue', 'Sales.orders'], dimensions: ['Sales.region'], timeDimensions: ['Sales.order_date'] },
  { name: 'HR', measures: ['HR.headcount'], dimensions: ['HR.dept'], timeDimensions: [] }, // caller has NO HR metric
];

test('narrows to the caller’s governed views (an unentitled Cube view is excluded)', () => {
  const views = narrowCubeMeta(['Sales.revenue'], meta);
  assert.equal(views.length, 1, 'only the entitled view');
  assert.equal(views[0].view, 'Sales');
  assert.deepEqual(views[0].measures, ['Sales.revenue', 'Sales.orders']);
  assert.deepEqual(views[0].dimensions, ['Sales.region']);
  assert.deepEqual(views[0].timeDimensions, ['Sales.order_date']);
  assert.ok(!views.some((v) => v.view === 'HR'), 'HR is not exposed — the caller has no metric on it');
});

test('a governed view Cube does not report falls back to the registry measures', () => {
  const views = narrowCubeMeta(['Campaign.spend', 'Campaign.clicks'], meta);
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'Campaign');
  assert.deepEqual(views[0].measures.sort(), ['Campaign.clicks', 'Campaign.spend']);
  assert.deepEqual(views[0].dimensions, []);
});

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

test('served flag: a Cube-reported view is served:true; an unreported one is served:false (loud, not silent)', () => {
  const views = narrowCubeMeta(['Sales.revenue', 'Campaign.spend'], meta);
  const sales = views.find((v) => v.view === 'Sales')!;
  const campaign = views.find((v) => v.view === 'Campaign')!;
  assert.equal(sales.served, true);
  assert.equal(campaign.served, false, 'the degradation is FLAGGED — the builder warns instead of silently emptying');
});

test('Northpeak fix: an unserved view’s group-bys come from the GOVERNED REGISTRY — never a silently empty palette', () => {
  // The missing/stale-domain-table case: Cube can't serve the view, but the registry
  // knows the gold dimensions. The palette must still offer them (spec created + flagged).
  const registryDims = new Map([
    ['Campaign', { dimensions: ['Campaign.partner_name', 'Campaign.service_center_id'], timeDimensions: ['Campaign.created_at'] }],
  ]);
  const views = narrowCubeMeta(['Campaign.spend'], meta, registryDims);
  assert.equal(views.length, 1);
  assert.equal(views[0].served, false);
  assert.deepEqual(views[0].dimensions, ['Campaign.partner_name', 'Campaign.service_center_id']);
  assert.deepEqual(views[0].timeDimensions, ['Campaign.created_at']);
});

test('the registry fallback never leaks a view the caller has no metric on', () => {
  const registryDims = new Map([['HR', { dimensions: ['HR.dept'], timeDimensions: [] }]]);
  const views = narrowCubeMeta(['Sales.revenue'], meta, registryDims);
  assert.ok(!views.some((v) => v.view === 'HR'), 'entitlement narrowing still wins');
});

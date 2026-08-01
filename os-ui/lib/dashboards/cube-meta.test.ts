/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * narrowCubeMeta: the panel builder's palette, narrowed to the caller's GOVERNED views.
 * Registry-only since the metrics→Trino migration (Phase 2): measures come from the
 * caller's own members, group-bys from the registry — Cube's /meta is ignored (kept as
 * a call-site param until Phase 3 deletes it). A view the caller has no metric on is
 * NEVER returned, even when the registry knows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CubeMetaView } from '../infra/governed.ts';
import { narrowCubeMeta } from './cube-meta.ts';

// Cube's /meta — deliberately present to prove it is IGNORED (HR is reported by
// Cube but unentitled; Sales' Cube dims differ from the registry's).
const meta: CubeMetaView[] = [
  { name: 'Sales', measures: ['Sales.revenue', 'Sales.orders'], dimensions: ['Sales.cube_only_dim'], timeDimensions: [] },
  { name: 'HR', measures: ['HR.headcount'], dimensions: ['HR.dept'], timeDimensions: [] }, // caller has NO HR metric
];

test('narrows to the caller’s governed views (an unentitled view is excluded)', () => {
  const registryDims = new Map([
    ['Sales', { dimensions: ['Sales.region'], timeDimensions: ['Sales.order_date'] }],
  ]);
  const views = narrowCubeMeta(['Sales.revenue'], meta, registryDims);
  assert.equal(views.length, 1, 'only the entitled view');
  assert.equal(views[0].view, 'Sales');
  assert.deepEqual(views[0].measures, ['Sales.revenue']); // the caller's OWN members
  assert.deepEqual(views[0].dimensions, ['Sales.region']); // registry, NOT Cube's /meta
  assert.deepEqual(views[0].timeDimensions, ['Sales.order_date']);
  assert.ok(!views.some((v) => v.view === 'HR'), 'HR is not exposed — the caller has no metric on it');
});

test('measures are the caller’s registry members — with or without registry dims', () => {
  const views = narrowCubeMeta(['Campaign.spend', 'Campaign.clicks'], meta);
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'Campaign');
  assert.deepEqual(views[0].measures.sort(), ['Campaign.clicks', 'Campaign.spend']);
  assert.deepEqual(views[0].dimensions, []); // no registry dims passed → honestly empty
});

test('served is always TRUE since Phase 2 — panels serve as governed SQL from the registry', () => {
  const views = narrowCubeMeta(['Sales.revenue', 'Campaign.spend'], meta);
  assert.ok(views.every((v) => v.served), 'no "Cube not serving" state exists on the SQL read path');
});

test('the group-bys come from the GOVERNED REGISTRY — palette equals executor capability', () => {
  const registryDims = new Map([
    ['Campaign', { dimensions: ['Campaign.partner_name', 'Campaign.service_center_id'], timeDimensions: ['Campaign.created_at'] }],
  ]);
  const views = narrowCubeMeta(['Campaign.spend'], meta, registryDims);
  assert.equal(views.length, 1);
  assert.equal(views[0].served, true);
  assert.deepEqual(views[0].dimensions, ['Campaign.partner_name', 'Campaign.service_center_id']);
  assert.deepEqual(views[0].timeDimensions, ['Campaign.created_at']);
});

test('the registry never leaks a view the caller has no metric on', () => {
  const registryDims = new Map([['HR', { dimensions: ['HR.dept'], timeDimensions: [] }]]);
  const views = narrowCubeMeta(['Sales.revenue'], meta, registryDims);
  assert.ok(!views.some((v) => v.view === 'HR'), 'entitlement narrowing still wins');
});

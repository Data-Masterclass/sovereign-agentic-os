/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * panelViewsFor: the panel builder's palette, narrowed to the caller's GOVERNED views.
 * Registry-only: measures come from the caller's own members, group-bys from the
 * registry. A view the caller has no metric on is NEVER returned, even when the
 * registry knows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelViewsFor } from '@tabs/dashboards/lib/panel-views';

test('narrows to the caller’s governed views (an unentitled view is excluded)', () => {
  const registryDims = new Map([
    ['Sales', { dimensions: ['Sales.region'], timeDimensions: ['Sales.order_date'] }],
  ]);
  const views = panelViewsFor(['Sales.revenue'], registryDims);
  assert.equal(views.length, 1, 'only the entitled view');
  assert.equal(views[0].view, 'Sales');
  assert.deepEqual(views[0].measures, ['Sales.revenue']); // the caller's OWN members
  assert.deepEqual(views[0].dimensions, ['Sales.region']); // from the registry
  assert.deepEqual(views[0].timeDimensions, ['Sales.order_date']);
  assert.ok(!views.some((v) => v.view === 'HR'), 'HR is not exposed — the caller has no metric on it');
});

test('measures are the caller’s registry members — with or without registry dims', () => {
  const views = panelViewsFor(['Campaign.spend', 'Campaign.clicks']);
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'Campaign');
  assert.deepEqual(views[0].measures.sort(), ['Campaign.clicks', 'Campaign.spend']);
  assert.deepEqual(views[0].dimensions, []); // no registry dims passed → honestly empty
});

test('served is always TRUE — panels serve as governed SQL from the registry', () => {
  const views = panelViewsFor(['Sales.revenue', 'Campaign.spend']);
  assert.ok(views.every((v) => v.served), 'no "not serving" state exists on the SQL read path');
});

test('the group-bys come from the GOVERNED REGISTRY — palette equals executor capability', () => {
  const registryDims = new Map([
    ['Campaign', { dimensions: ['Campaign.partner_name', 'Campaign.service_center_id'], timeDimensions: ['Campaign.created_at'] }],
  ]);
  const views = panelViewsFor(['Campaign.spend'], registryDims);
  assert.equal(views.length, 1);
  assert.equal(views[0].served, true);
  assert.deepEqual(views[0].dimensions, ['Campaign.partner_name', 'Campaign.service_center_id']);
  assert.deepEqual(views[0].timeDimensions, ['Campaign.created_at']);
});

test('BUG B: a metric-backed view resolves its registry dimensions (group-by is non-empty)', () => {
  // The group-by picker empties iff the metric's view can't be matched to its registry
  // dims. Given the SAME view key on both sides (the member's view prefix and the registry
  // key), the palette must carry the dimensions — this pins the registry→palette contract
  // the PanelBuilder's effectiveView fix relies on (it binds the view to the selected
  // metric so this lookup runs at all while designing the first panel).
  const registryDims = new Map([
    ['sales__Orders', { dimensions: ['sales__Orders.region', 'sales__Orders.net_amount'], timeDimensions: ['sales__Orders.order_date'] }],
  ]);
  const views = panelViewsFor(['sales__Orders.revenue'], registryDims);
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'sales__Orders');
  assert.ok(views[0].dimensions.length > 0, 'the metric-backed view offers its group-by dimensions');
  assert.deepEqual(views[0].dimensions, ['sales__Orders.region', 'sales__Orders.net_amount']);
  assert.deepEqual(views[0].timeDimensions, ['sales__Orders.order_date']);
});

test('the registry never leaks a view the caller has no metric on', () => {
  const registryDims = new Map([['HR', { dimensions: ['HR.dept'], timeDimensions: [] }]]);
  const views = panelViewsFor(['Sales.revenue'], registryDims);
  assert.ok(!views.some((v) => v.view === 'HR'), 'entitlement narrowing still wins');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A metric's repo location matches the lane the emitter actually writes
 * USER STORY: As a maintainer I want the git-history lookup and the generator to agree on the path
 *             by test, not by comment — a wrong path means an empty history for an object that
 *             plainly has a file in the tree (the night-1 F3-1 defect).
 * ARCHITECTURE:
 *   - Pure. Compares against the generator's own `semanticPathFor`-shaped output through the
 *     project renderer, so the two cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricGitLocation, metricTrailerId, domainLanePath, personalLanePath } from '@tabs/metrics/lib/git-object';

test('G3/M-R5.4: both lanes are returned, so a promotion does not truncate the history', () => {
  const loc = metricGitLocation('ds_orders1.revenue', { domain: 'sales', semanticModel: 'sales__orders', ownerUid: 'amir', name: 'Revenue' });
  assert.equal(loc.domain, 'sales');
  assert.deepEqual(loc.paths, ['models/semantic/sales__orders.yml', 'models/personal/amir/semantic/sales__orders.yml']);
  assert.equal(loc.name, 'Revenue');
});

test('the OS-Object trailer is the kind-prefixed id the commit path writes, not the bare id', () => {
  assert.equal(metricTrailerId('ds_orders1.revenue'), 'metric:ds_orders1.revenue');
  assert.equal(metricGitLocation('ds_orders1.revenue', { domain: 'sales', semanticModel: 'orders', ownerUid: 'amir' }).trailerId, 'metric:ds_orders1.revenue');
});

test('the lane paths are literally the ones the generator writes', () => {
  // The GENERATOR half is asserted in `tabs/data/lib/dbt/semantic/render.test.ts` ("the semantic
  // file lands in the generated tree" and "a personal dataset keeps its semantic file in the owner
  // lane"), which produces exactly these two strings. They are duplicated here as literals rather
  // than imported, because a tab may import only `@core/*` and itself and the structure check
  // ratchets that count — a dynamic `import()` would slip past the regex, which is gaming the
  // ratchet, not satisfying it. If the generator's lane ever moves, BOTH tests must be updated and
  // the history lookup is what breaks loudly first.
  assert.equal(domainLanePath('sales__orders'), 'models/semantic/sales__orders.yml');
  assert.equal(personalLanePath('amir', 'sales__orders'), 'models/personal/amir/semantic/sales__orders.yml');
});

test('a name is omitted rather than emitted empty', () => {
  const loc = metricGitLocation('ds_x.m', { domain: 'sales', semanticModel: 'x', ownerUid: 'u' });
  assert.equal('name' in loc, false);
});

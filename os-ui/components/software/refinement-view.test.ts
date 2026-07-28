/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the refinement view-adapter (components/software/refinement-view.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsFor,
  lanesFor,
  buildableBatch,
  buildBatchCapped,
  stateBadgeClass,
  dimensionTag,
  REFINE_BUILD_CAP,
} from './refinement-view.ts';
import type { Improvement } from '@/lib/software/improvements';

const design = (id: string, state: Improvement['state'] = 'proposed'): Improvement =>
  ({ id, kind: 'design', epicId: 'e1', storyId: 's1', note: 'n', state });
const rebuild = (id: string, state: Improvement['state'] = 'proposed'): Improvement =>
  ({ id, kind: 'rebuild', epicId: 'e1', storyId: 's1', note: 'n', state });

test('actionsFor: a proposed design-kind offers the two-step Design + the Design&Build accelerator', () => {
  assert.deepEqual(actionsFor(design('a')), ['design', 'designAndBuild']);
});

test('actionsFor: a buildable item (rebuild-proposed or designed) offers only Build', () => {
  assert.deepEqual(actionsFor(rebuild('a')), ['build']);
  assert.deepEqual(actionsFor(design('a', 'designed')), ['build']);
});

test('actionsFor: a built item offers nothing (done, kept only for transparency)', () => {
  assert.deepEqual(actionsFor(rebuild('a', 'built')), []);
  assert.deepEqual(actionsFor(design('a', 'built')), []);
});

test('lanesFor: groups into toDesign / toBuild / done with built items retained', () => {
  const list = [design('a'), rebuild('b'), design('c', 'designed'), rebuild('d', 'built')];
  const lanes = lanesFor(list);
  assert.deepEqual(lanes.toDesign.map((i) => i.id), ['a']);
  assert.deepEqual(lanes.toBuild.map((i) => i.id), ['b', 'c']);
  assert.deepEqual(lanes.done.map((i) => i.id), ['d']);
});

test('design-before-build gate in the view: a proposed design-kind is NOT in the build lane', () => {
  const lanes = lanesFor([design('a')]);
  assert.equal(lanes.toBuild.length, 0, 'proposed design item is gated out of Build');
  assert.equal(lanes.toDesign.length, 1);
});

test('buildableBatch: caps the Build-all batch at the reviewable cap (8), remainder left', () => {
  const many = Array.from({ length: REFINE_BUILD_CAP + 3 }, (_, i) => rebuild(`r${i}`));
  const batch = buildableBatch(many);
  assert.equal(batch.length, REFINE_BUILD_CAP);
  assert.equal(buildBatchCapped(many), true);
  assert.equal(buildBatchCapped([rebuild('a'), rebuild('b')]), false);
});

test('buildableBatch: excludes gated design-proposed items from the batch', () => {
  const batch = buildableBatch([design('a'), rebuild('b')]);
  assert.deepEqual(batch.map((i) => i.id), ['b']);
});

test('stateBadgeClass: proposed → muted, designed → warn(gold), built → ok', () => {
  assert.equal(stateBadgeClass('proposed'), 'badge muted');
  assert.equal(stateBadgeClass('designed'), 'badge warn');
  assert.equal(stateBadgeClass('built'), 'badge ok');
});

test('dimensionTag: compact per-row tag for each dimension', () => {
  assert.equal(dimensionTag('functionality'), 'FN');
  assert.equal(dimensionTag('ux'), 'UX');
  assert.equal(dimensionTag('code'), 'CODE');
  assert.equal(dimensionTag('security'), 'SEC');
  assert.equal(dimensionTag('docs'), 'DOC');
});

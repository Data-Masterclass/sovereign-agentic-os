/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the Test→Build improvement loop model (lib/software/improvements.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeImprovement,
  isBuildable,
  isDesignable,
  improvementsForStory,
  dropImprovement,
  kindLabel,
  stateLabel,
  dimensionLabel,
  refinementState,
  markDesigned,
  markBuilt,
  markDesignedById,
  markBuiltById,
  refinementsToDesign,
  refinementsToBuild,
  allRefinements,
  designAll,
  buildAll,
  designThenBuild,
  type Improvement,
} from './improvements.ts';

const validStory = (id: string) => (id === 's1' || id === 's2' ? { epicId: 'e1' } : null);

test('improvements: a missed-spec improvement is a buildable REBUILD tied to the right story', () => {
  const imp = normalizeImprovement({ storyId: 's1', note: 'totals should be bold' }, validStory);
  assert.ok(imp);
  assert.equal(imp!.kind, 'rebuild'); // default = missed-spec
  assert.equal(imp!.epicId, 'e1');
  assert.equal(imp!.storyId, 's1');
  assert.equal(isBuildable(imp!), true);
});

test('improvements: a scope-changing feedback routes to DESIGN, not directly buildable', () => {
  const imp = normalizeImprovement({ kind: 'design', storyId: 's1', note: 'add a CSV export column' }, validStory);
  assert.ok(imp);
  assert.equal(imp!.kind, 'design');
  assert.equal(isBuildable(imp!), false); // must be specified in Design first
  assert.equal(kindLabel('design'), 'needs design');
  assert.equal(kindLabel('rebuild'), 'rebuild');
});

test('improvements: an improvement that can not be tied to a real story is dropped', () => {
  assert.equal(normalizeImprovement({ storyId: 'ghost', note: 'x' }, validStory), null);
  assert.equal(normalizeImprovement({ storyId: 's1', note: '' }, validStory), null);
  assert.equal(normalizeImprovement({ note: 'no story' }, validStory), null);
});

test('improvements: feature index is carried when present and non-negative', () => {
  assert.equal(normalizeImprovement({ storyId: 's1', note: 'x', featureIndex: 2 }, validStory)!.featureIndex, 2);
  assert.equal(normalizeImprovement({ storyId: 's1', note: 'x', featureIndex: -1 }, validStory)!.featureIndex, undefined);
});

test('improvements: per-story filter + drop', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'rebuild', epicId: 'e1', storyId: 's1', note: 'x' },
    { id: 'b', kind: 'design', epicId: 'e1', storyId: 's2', note: 'y' },
  ];
  assert.deepEqual(improvementsForStory(list, 's1').map((i) => i.id), ['a']);
  assert.deepEqual(dropImprovement(list, 'a').map((i) => i.id), ['b']);
});

// ------------------------------------------------------- 5-dimension tagging --

test('refinement: a shortfall carries its Test dimension tag', () => {
  const imp = normalizeImprovement({ storyId: 's1', note: 'no empty state', dimension: 'ux' }, validStory);
  assert.equal(imp!.dimension, 'ux');
  assert.equal(dimensionLabel('ux'), 'User Experience');
  assert.equal(dimensionLabel('functionality'), 'Functionality');
  assert.equal(dimensionLabel('code'), 'Code Structure');
  assert.equal(dimensionLabel('security'), 'Security');
  assert.equal(dimensionLabel('docs'), 'Documentation');
});

test('refinement: a bogus dimension is dropped, not smuggled through', () => {
  const imp = normalizeImprovement({ storyId: 's1', note: 'x', dimension: 'performance' }, validStory);
  assert.equal(imp!.dimension, undefined);
});

// ----------------------------------------------------- lifecycle state machine --

test('refinement: new items start proposed; legacy items with no state read as proposed', () => {
  const fresh = normalizeImprovement({ storyId: 's1', note: 'x' }, validStory)!;
  assert.equal(fresh.state, 'proposed');
  assert.equal(refinementState(fresh), 'proposed');
  const legacy: Improvement = { id: 'l', kind: 'rebuild', epicId: 'e1', storyId: 's1', note: 'x' };
  assert.equal(refinementState(legacy), 'proposed');
});

test('refinement gate: design-kind proposed is NOT buildable until designed (design-before-build)', () => {
  const design = normalizeImprovement({ kind: 'design', storyId: 's1', note: 'add CSV export' }, validStory)!;
  assert.equal(isDesignable(design), true);
  assert.equal(isBuildable(design), false); // gated
  const designed = markDesigned(design, 'features: CSV export column');
  assert.equal(designed.state, 'designed');
  assert.equal(designed.draftedSpec, 'features: CSV export column');
  assert.equal(isDesignable(designed), false); // past design
  assert.equal(isBuildable(designed), true); // now buildable
  const built = markBuilt(designed);
  assert.equal(built.state, 'built');
  assert.equal(isBuildable(built), false); // done, not buildable again
});

test('refinement gate: rebuild-kind is buildable straight from proposed and skips design', () => {
  const rebuild = normalizeImprovement({ storyId: 's1', note: 'totals bold' }, validStory)!;
  assert.equal(isDesignable(rebuild), false);
  assert.equal(isBuildable(rebuild), true);
  assert.equal(isBuildable(markBuilt(rebuild)), false);
});

test('refinement: mark-by-id transforms only the targeted item, purely', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'design', epicId: 'e1', storyId: 's1', note: 'x', state: 'proposed' },
    { id: 'b', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'y', state: 'proposed' },
  ];
  const d = markDesignedById(list, 'a', 'spec');
  assert.equal(d.find((i) => i.id === 'a')!.state, 'designed');
  assert.equal(d.find((i) => i.id === 'b')!.state, 'proposed');
  assert.equal(list[0].state, 'proposed'); // original untouched (pure)
  const b = markBuiltById(d, 'b');
  assert.equal(b.find((i) => i.id === 'b')!.state, 'built');
});

// ---------------------------------------------------------------- selectors --

test('refinement selectors: to-design / to-build / all (done retained)', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'design', epicId: 'e1', storyId: 's1', note: 'x', state: 'proposed' }, // designable
    { id: 'b', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'y', state: 'proposed' }, // buildable
    { id: 'c', kind: 'design', epicId: 'e1', storyId: 's1', note: 'z', state: 'designed' }, // buildable
    { id: 'd', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'w', state: 'built' }, // done
  ];
  assert.deepEqual(refinementsToDesign(list).map((i) => i.id), ['a']);
  assert.deepEqual(refinementsToBuild(list).map((i) => i.id), ['b', 'c']);
  assert.deepEqual(allRefinements(list).map((i) => i.id), ['a', 'b', 'c', 'd'], 'built items stay visible');
});

// ------------------------------------------------------------------ batches --

test('refinement batch: design-all drafts every designable, leaves others alone', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'design', epicId: 'e1', storyId: 's1', note: 'x', state: 'proposed' },
    { id: 'b', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'y', state: 'proposed' },
  ];
  const out = designAll(list, (imp) => `drafted:${imp.id}`);
  assert.equal(out.find((i) => i.id === 'a')!.state, 'designed');
  assert.equal(out.find((i) => i.id === 'a')!.draftedSpec, 'drafted:a');
  assert.equal(out.find((i) => i.id === 'b')!.state, 'proposed'); // rebuild untouched by design
});

test('refinement batch: build-all marks every buildable built, leaves gated design proposed', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'design', epicId: 'e1', storyId: 's1', note: 'x', state: 'proposed' }, // gated
    { id: 'b', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'y', state: 'proposed' },
    { id: 'c', kind: 'design', epicId: 'e1', storyId: 's1', note: 'z', state: 'designed' },
  ];
  const out = buildAll(list);
  assert.equal(out.find((i) => i.id === 'a')!.state, 'proposed'); // still needs design first
  assert.equal(out.find((i) => i.id === 'b')!.state, 'built');
  assert.equal(out.find((i) => i.id === 'c')!.state, 'built');
});

test('refinement: design-then-build convenience yields both steps in order', () => {
  const list: Improvement[] = [
    { id: 'a', kind: 'design', epicId: 'e1', storyId: 's1', note: 'x', state: 'proposed' },
    { id: 'b', kind: 'rebuild', epicId: 'e1', storyId: 's2', note: 'y', state: 'proposed' },
  ];
  const { designed, built } = designThenBuild(list, () => 'spec');
  // After design: the design item is designed, then everything buildable is built.
  assert.equal(designed.find((i) => i.id === 'a')!.state, 'designed');
  assert.equal(built.find((i) => i.id === 'a')!.state, 'built');
  assert.equal(built.find((i) => i.id === 'b')!.state, 'built');
});

test('refinement labels: honest state labels', () => {
  assert.equal(stateLabel('proposed'), 'proposed');
  assert.equal(stateLabel('designed'), 'designed');
  assert.equal(stateLabel('built'), 'built');
});

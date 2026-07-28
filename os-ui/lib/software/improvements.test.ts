/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the Test→Build improvement loop model (lib/software/improvements.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeImprovement,
  isBuildable,
  improvementsForStory,
  dropImprovement,
  kindLabel,
  type Improvement,
} from './improvements.ts';

const validStory = (id: string) => (id === 's1' ? { epicId: 'e1' } : null);

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

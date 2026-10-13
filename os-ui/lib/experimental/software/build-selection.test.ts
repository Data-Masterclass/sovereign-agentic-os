/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the Build stage capped batch-select model (lib/software/build-selection.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_BATCH_CAP,
  featureId,
  storyFeatureIds,
  epicFeatureIds,
  capReached,
  canSelectFeature,
  toggleFeature,
  groupSelectState,
  toggleGroup,
  pruneSelection,
  type SelEpic,
} from './build-selection.ts';

const story = (id: string, n: number): { id: string; spec: { features: string[] } } => ({
  id,
  spec: { features: Array.from({ length: n }, (_, i) => `f${i}`) },
});

test('build-selection: the cap default is 8, changeable in one place', () => {
  assert.equal(BUILD_BATCH_CAP, 8);
});

test('build-selection: feature ids are per-story + index; story/epic roll them up', () => {
  assert.equal(featureId('s1', 2), 's1#f2');
  assert.deepEqual(storyFeatureIds(story('s1', 3)), ['s1#f0', 's1#f1', 's1#f2']);
  assert.deepEqual(storyFeatureIds({ id: 's2' }), []); // no spec → no features
  const epic: SelEpic = { id: 'e1', stories: [story('s1', 2), story('s2', 1)] };
  assert.deepEqual(epicFeatureIds(epic), ['s1#f0', 's1#f1', 's2#f0']);
});

test('build-selection: toggleFeature adds/removes and respects the cap on turn-ON', () => {
  let sel = new Set<string>();
  sel = toggleFeature(sel, 'a');
  assert.ok(sel.has('a'));
  sel = toggleFeature(sel, 'a'); // un-tick
  assert.equal(sel.has('a'), false);
});

test('build-selection: past the cap, an UNSELECTED feature cannot be ticked; selected ones still toggle', () => {
  // Fill to the cap.
  let sel = new Set<string>();
  for (let i = 0; i < BUILD_BATCH_CAP; i++) sel = toggleFeature(sel, `x${i}`);
  assert.equal(sel.size, BUILD_BATCH_CAP);
  assert.equal(capReached(sel), true);
  // A NEW feature is refused (no silent truncation of others).
  assert.equal(canSelectFeature('new', sel), false);
  const after = toggleFeature(sel, 'new');
  assert.equal(after.size, BUILD_BATCH_CAP);
  assert.equal(after.has('new'), false);
  // An already-selected feature can always be un-ticked.
  assert.equal(canSelectFeature('x0', sel), true);
  assert.equal(toggleFeature(sel, 'x0').has('x0'), false);
});

test('build-selection: groupSelectState is none/some/all', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(groupSelectState(ids, new Set()), 'none');
  assert.equal(groupSelectState(ids, new Set(['a'])), 'some');
  assert.equal(groupSelectState(ids, new Set(['a', 'b', 'c'])), 'all');
  assert.equal(groupSelectState([], new Set()), 'none');
});

test('build-selection: cascade toggleGroup selects up to the cap, then stops (no partial eviction)', () => {
  // A story with 10 features, cap 8 → selecting the story selects 8, leaves 2.
  const ids = Array.from({ length: 10 }, (_, i) => `s#f${i}`);
  const sel = toggleGroup(new Set<string>(), ids);
  assert.equal(sel.size, BUILD_BATCH_CAP);
  assert.deepEqual([...sel].sort(), ids.slice(0, BUILD_BATCH_CAP).sort());
});

test('build-selection: cascade toggleGroup deselects fully when all are on', () => {
  const ids = ['a', 'b', 'c'];
  const all = new Set(ids);
  assert.equal(toggleGroup(all, ids).size, 0);
});

test('build-selection: cascade select never evicts a feature already selected elsewhere', () => {
  // 6 already selected from another group; a new group of 4 can only add 2 (cap 8).
  const other = new Set(['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
  const groupIds = ['g0', 'g1', 'g2', 'g3'];
  const sel = toggleGroup(other, groupIds);
  assert.equal(sel.size, BUILD_BATCH_CAP);
  // The other group's selections all survive.
  for (const id of other) assert.ok(sel.has(id));
});

test('build-selection: pruneSelection drops ids no longer in the tree', () => {
  const epics: SelEpic[] = [{ id: 'e1', stories: [story('s1', 2)] }];
  const sel = new Set(['s1#f0', 's1#f9', 'ghost']);
  assert.deepEqual([...pruneSelection(sel, epics)], ['s1#f0']);
});

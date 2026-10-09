/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the Build-stage epic/story tree derivation (lib/software/story-tree.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStoryStatus,
  storyProgress,
  deriveEpicStatus,
  epicProgress,
  currentEpicIndex,
  clampEpicIndex,
  type BuildRunSignals,
} from './story-tree.ts';

test('story-tree: clampEpicIndex keeps one-at-a-time nav in bounds', () => {
  assert.equal(clampEpicIndex(0, 3), 0);
  assert.equal(clampEpicIndex(2, 3), 2);
  assert.equal(clampEpicIndex(5, 3), 2); // past the end → last
  assert.equal(clampEpicIndex(-1, 3), 0); // before the start → first
  assert.equal(clampEpicIndex(0, 0), 0); // empty → 0
});

const idle: BuildRunSignals = { targetedStoryId: null, running: false, failedStoryIds: new Set() };

test('story-tree: a plain story is todo', () => {
  assert.equal(deriveStoryStatus({ id: 's1' }, idle), 'todo');
  assert.equal(deriveStoryStatus({ id: 's1', status: 'todo' }, idle), 'todo');
});

test('story-tree: persisted done shows done', () => {
  assert.equal(deriveStoryStatus({ id: 's1', status: 'done' }, idle), 'done');
});

test('story-tree: the targeted story of a running build shows building', () => {
  const run: BuildRunSignals = { targetedStoryId: 's1', running: true, failedStoryIds: new Set() };
  assert.equal(deriveStoryStatus({ id: 's1' }, run), 'building');
  // Other stories are untouched by the run.
  assert.equal(deriveStoryStatus({ id: 's2' }, run), 'todo');
  // Targeted but NOT running is not "building" — no fabricated activity.
  assert.equal(deriveStoryStatus({ id: 's1' }, { ...run, running: false }), 'todo');
});

test('story-tree: a story whose last build failed shows blocked', () => {
  const run: BuildRunSignals = { targetedStoryId: null, running: false, failedStoryIds: new Set(['s1']) };
  assert.equal(deriveStoryStatus({ id: 's1' }, run), 'blocked');
});

test('story-tree: precedence is building > blocked > done', () => {
  const failed = new Set(['s1']);
  // A running re-run of a failed story shows building (freshest signal).
  assert.equal(
    deriveStoryStatus({ id: 's1', status: 'done' }, { targetedStoryId: 's1', running: true, failedStoryIds: failed }),
    'building',
  );
  // A done story whose later run failed shows blocked (fresher than done).
  assert.equal(
    deriveStoryStatus({ id: 's1', status: 'done' }, { targetedStoryId: null, running: false, failedStoryIds: failed }),
    'blocked',
  );
});

test('story-tree: stale persisted building (no run in flight) is honestly todo', () => {
  assert.equal(deriveStoryStatus({ id: 's1', status: 'building' }, idle), 'todo');
});

test('story-tree: progress counts done stories across epics', () => {
  const epics = [
    { id: 'e1', stories: [{ id: 'a', status: 'done' as const }, { id: 'b' }, { id: 'c', status: 'done' as const }] },
    { id: 'e2', stories: [{ id: 'd' }] },
    { id: 'e3', stories: [] },
  ];
  assert.deepEqual(storyProgress(epics), { built: 2, total: 4 });
  assert.deepEqual(storyProgress([]), { built: 0, total: 0 });
});

test('story-tree: epic status is honest — not-started / in-progress / done', () => {
  // No stories yet → not-started (nothing to build).
  assert.equal(deriveEpicStatus({ id: 'e', stories: [] }), 'not-started');
  // No done stories → not-started.
  assert.equal(deriveEpicStatus({ id: 'e', stories: [{ id: 'a' }, { id: 'b' }] }), 'not-started');
  // Some done → in-progress.
  assert.equal(
    deriveEpicStatus({ id: 'e', stories: [{ id: 'a', status: 'done' }, { id: 'b' }] }),
    'in-progress',
  );
  // All done → done.
  assert.equal(
    deriveEpicStatus({ id: 'e', stories: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }] }),
    'done',
  );
});

test('story-tree: epicProgress counts done vs total for one epic', () => {
  assert.deepEqual(epicProgress({ id: 'e', stories: [{ id: 'a', status: 'done' }, { id: 'b' }] }), { built: 1, total: 2 });
  assert.deepEqual(epicProgress({ id: 'e', stories: [] }), { built: 0, total: 0 });
});

test('story-tree: currentEpicIndex points at the first not-done epic', () => {
  const epics = [
    { id: 'e1', stories: [{ id: 'a', status: 'done' as const }] }, // done
    { id: 'e2', stories: [{ id: 'b', status: 'done' as const }, { id: 'c' }] }, // in-progress
    { id: 'e3', stories: [{ id: 'd' }] }, // not-started
  ];
  assert.equal(currentEpicIndex(epics), 1);
  // All done → -1 (the journey is complete).
  assert.equal(currentEpicIndex([{ id: 'e', stories: [{ id: 'a', status: 'done' as const }] }]), -1);
  // No epics → -1.
  assert.equal(currentEpicIndex([]), -1);
});

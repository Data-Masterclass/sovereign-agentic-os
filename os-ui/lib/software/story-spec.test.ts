/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the per-story spec + Build checklist derivation (lib/software/story-spec.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySpec,
  specHasContent,
  specItemCount,
  normalizeSpec,
  deriveStoryChecklist,
  deriveEpicOverview,
  everyStoryHasSpec,
  type StorySpec,
} from './story-spec.ts';

test('story-spec: emptySpec is three empty lists with no content', () => {
  const s = emptySpec();
  assert.deepEqual(s, { features: [], nfrs: [], rules: [] });
  assert.equal(specHasContent(s), false);
  assert.equal(specItemCount(s), 0);
});

test('story-spec: specHasContent / specItemCount are nil-safe', () => {
  assert.equal(specHasContent(undefined), false);
  assert.equal(specHasContent(null), false);
  assert.equal(specItemCount(undefined), 0);
  const s: StorySpec = { features: ['a', 'b'], nfrs: ['c'], rules: [] };
  assert.equal(specHasContent(s), true);
  assert.equal(specItemCount(s), 3);
});

test('story-spec: normalizeSpec trims, drops blanks, coerces non-arrays', () => {
  const out = normalizeSpec({ features: ['  Send email ', '', 42, 'Log it'], nfrs: 'not-an-array', rules: [' Approve '] });
  assert.deepEqual(out, { features: ['Send email', 'Log it'], nfrs: [], rules: ['Approve'] });
});

test('story-spec: normalizeSpec returns undefined for empty/garbage (byte-stable absence)', () => {
  assert.equal(normalizeSpec(undefined), undefined);
  assert.equal(normalizeSpec(null), undefined);
  assert.equal(normalizeSpec('x'), undefined);
  assert.equal(normalizeSpec({ features: [], nfrs: [' '], rules: [] }), undefined);
});

test('story-spec: a story with no spec yields an empty checklist', () => {
  const c = deriveStoryChecklist({ status: 'done' });
  assert.deepEqual(c, { items: [], built: 0, total: 0 });
});

test('story-spec: a not-done story shows every spec item pending — never fake-ticked', () => {
  const spec: StorySpec = { features: ['F1'], nfrs: ['N1'], rules: ['R1'] };
  const c = deriveStoryChecklist({ spec, status: 'todo' });
  assert.equal(c.total, 3);
  assert.equal(c.built, 0);
  assert.ok(c.items.every((i) => i.built === false));
  // building is also not done.
  assert.equal(deriveStoryChecklist({ spec, status: 'building' }).built, 0);
});

test('story-spec: a done story ticks all its spec items (story-granular honesty)', () => {
  const spec: StorySpec = { features: ['F1', 'F2'], nfrs: ['N1'], rules: [] };
  const c = deriveStoryChecklist({ spec, status: 'done' });
  assert.equal(c.total, 3);
  assert.equal(c.built, 3);
  assert.ok(c.items.every((i) => i.built === true));
  // kinds are preserved in features→nfrs→rules order.
  assert.deepEqual(c.items.map((i) => i.kind), ['feature', 'feature', 'nfr']);
});

test('story-spec: deriveEpicOverview rolls up stories + items honestly', () => {
  const epic = {
    stories: [
      { spec: { features: ['a', 'b'], nfrs: [], rules: [] }, status: 'done' as const }, // 2 items built
      { spec: { features: ['c'], nfrs: ['n'], rules: [] }, status: 'todo' as const }, // 2 items, none built
      { status: 'done' as const }, // done, no spec → 0 items
    ],
  };
  assert.deepEqual(deriveEpicOverview(epic), {
    storiesBuilt: 2,
    storiesTotal: 3,
    itemsBuilt: 2,
    itemsTotal: 4,
  });
  assert.deepEqual(deriveEpicOverview({ stories: [] }), {
    storiesBuilt: 0,
    storiesTotal: 0,
    itemsBuilt: 0,
    itemsTotal: 0,
  });
});

test('story-spec: everyStoryHasSpec is honest across epics', () => {
  // No stories anywhere → not design-complete.
  assert.equal(everyStoryHasSpec([{ stories: [] }]), false);
  assert.equal(everyStoryHasSpec([]), false);
  // One story missing a spec → false.
  assert.equal(
    everyStoryHasSpec([
      { stories: [{ spec: { features: ['a'], nfrs: [], rules: [] } }, { status: 'todo' }] },
    ]),
    false,
  );
  // Every story has ≥1 spec item → true.
  assert.equal(
    everyStoryHasSpec([
      { stories: [{ spec: { features: ['a'], nfrs: [], rules: [] } }] },
      { stories: [{ spec: { features: [], nfrs: ['n'], rules: [] } }] },
    ]),
    true,
  );
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, canEnter, initialStageState, isDone, isSatisfied, markDone, stageStatuses,
} from '@/lib/core/stages';
import { EXPOSE_STAGES, type ExposeCtx } from './stages.ts';

/**
 * The Expose guided path (Catalog · Organize · Assign · Review — 4 stages) on the shared stage
 * model (lakehouse-expose-experience.md, Phase A). Catalog is the always-reachable landing;
 * Organize is enterable-but-skippable (AI never blocks exposure); Assign opens once a table is
 * selected; Review opens once the set is ready to write (selection + name + ≥1 domain). No stage
 * shows a ✓ on first open — the ✓ rides a live `completed()` condition earned this session.
 */
const ctx = (over: Partial<ExposeCtx> = {}): ExposeCtx => ({
  hasSnapshot: false, snapshotStatus: 'none', selectedCount: 0,
  hasName: false, hasDomains: false, classified: false, ...over,
});

test('4 stages total, in order Catalog → Organize → Assign → Review', () => {
  const ids = EXPOSE_STAGES.map((s) => s.id);
  assert.deepEqual(ids, ['catalog', 'organize', 'assign', 'review']);
});

test('Catalog is the always-reachable landing; ✓ once a snapshot exists', () => {
  assert.equal(canEnter(EXPOSE_STAGES, 'catalog', ctx()), true);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'catalog', ctx()), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'catalog', ctx({ hasSnapshot: true })), true);
});

test('Organize never gates entry (AI is optional) — reachable even with nothing selected', () => {
  const organize = EXPOSE_STAGES.find((s) => s.id === 'organize');
  assert.equal(organize?.enabled, undefined, 'Organize must not gate entry');
  assert.equal(canEnter(EXPOSE_STAGES, 'organize', ctx()), true);
});

test('Organize ✓ = visited (classified) OR a selection made', () => {
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx()), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx({ classified: true })), true);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx({ selectedCount: 2 })), true);
});

test('Assign gates on a selection — closed at zero, open once a table is picked', () => {
  assert.equal(canEnter(EXPOSE_STAGES, 'assign', ctx({ selectedCount: 0 })), false);
  assert.equal(canEnter(EXPOSE_STAGES, 'assign', ctx({ selectedCount: 1 })), true);
});

test('Assign ✓ needs a name AND ≥1 domain', () => {
  assert.equal(isSatisfied(EXPOSE_STAGES, 'assign', ctx({ selectedCount: 1, hasName: true })), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'assign', ctx({ selectedCount: 1, hasDomains: true })), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'assign', ctx({ selectedCount: 1, hasName: true, hasDomains: true })), true);
});

test('Review gates on the whole set being ready to write (selection + name + domain)', () => {
  const almost = ctx({ selectedCount: 3, hasName: true, hasDomains: false });
  assert.equal(canEnter(EXPOSE_STAGES, 'review', almost), false);
  const ready = ctx({ selectedCount: 3, hasName: true, hasDomains: true });
  assert.equal(canEnter(EXPOSE_STAGES, 'review', ready), true);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'review', ready), true);
  // No selection → not ready even with a name + domain.
  assert.equal(canEnter(EXPOSE_STAGES, 'review', ctx({ hasName: true, hasDomains: true })), false);
});

test('opens on Catalog with NO pre-marked checks even when the ctx already satisfies stages', () => {
  const full = ctx({ hasSnapshot: true, selectedCount: 5, hasName: true, hasDomains: true, classified: true });
  const s = initialStageState(EXPOSE_STAGES);
  assert.equal(s.current, 'catalog');
  for (const st of stageStatuses(EXPOSE_STAGES, s, full)) assert.equal(st.done, false);
});

test('a ✓ shows only after the user worked the stage this session AND it still holds', () => {
  const ready = ctx({ hasSnapshot: true, selectedCount: 5, hasName: true, hasDomains: true, classified: true });
  let s = initialStageState(EXPOSE_STAGES);  // catalog
  s = advance(EXPOSE_STAGES, s, ready);       // → organize, catalog recorded (hasSnapshot ✓)
  assert.equal(isDone(EXPOSE_STAGES, s, 'catalog', ready), true);
  assert.equal(isDone(EXPOSE_STAGES, s, 'organize', ready), false); // not yet

  s = advance(EXPOSE_STAGES, s, ready);       // → assign, organize recorded
  assert.equal(isDone(EXPOSE_STAGES, s, 'organize', ready), true);

  // Drop the snapshot → catalog's recorded ✓ clears because its condition no longer holds.
  const noSnap = ctx({ selectedCount: 5, hasName: true, hasDomains: true, classified: true });
  assert.equal(isDone(EXPOSE_STAGES, s, 'catalog', noSnap), false);
});

test('advancing past Assign without a name does NOT fake its ✓', () => {
  // Selection is enough to enter Assign and reach Review, but no name → Assign not satisfied.
  const noName = ctx({ hasSnapshot: true, selectedCount: 2, hasName: false, hasDomains: true, classified: true });
  let s = initialStageState(EXPOSE_STAGES);
  s = markDone(s, 'catalog');
  // Jump straight to assign then try to advance to review — gated (review needs a name).
  s = advance(EXPOSE_STAGES, s, noName); // catalog → organize
  s = advance(EXPOSE_STAGES, s, noName); // organize → assign
  assert.equal(s.current, 'assign');
  const after = advance(EXPOSE_STAGES, s, noName); // assign → review? review not enterable (no name)
  assert.equal(after.current, 'assign', 'cannot advance to Review without a name');
  assert.equal(isDone(EXPOSE_STAGES, after, 'assign', noName), false);
});

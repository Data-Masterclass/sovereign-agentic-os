/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, canEnter, initialStageState, isDone, isSatisfied, stageStatuses,
} from '@core/kernel/stages';
import { EXPOSE_STAGES, type ExposeCtx } from '@tabs/connections/ui/expose/stages';

/**
 * The Expose guided path (Catalog · Organize · Assign · Review — 4 stages) on the shared stage
 * model (lakehouse-expose-experience.md, Phase A). Catalog is the always-reachable landing;
 * Organize is enterable-but-skippable (AI never blocks exposure); Assign opens once a table is
 * selected; Review opens once the set is ready to write (selection + name + ≥1 domain). A ✓ is
 * derived from the exposure itself (the form, or the saved set when editing) — never from which
 * stages were visited — so a new exposure opens with none and a saved one opens ticked.
 */
const ctx = (over: Partial<ExposeCtx> = {}): ExposeCtx => ({
  hasSnapshot: false, snapshotStatus: 'none', selectedCount: 0,
  hasName: false, hasDomains: false, classified: false, saved: false, ...over,
});

test('4 stages total, in order Catalog → Organize → Assign → Review', () => {
  const ids = EXPOSE_STAGES.map((s) => s.id);
  assert.deepEqual(ids, ['catalog', 'organize', 'assign', 'review']);
});

test('Catalog is the always-reachable landing; ✓ once tables are picked from a snapshot', () => {
  assert.equal(canEnter(EXPOSE_STAGES, 'catalog', ctx()), true);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'catalog', ctx()), false);
  // A snapshot that merely EXISTS is a precondition, not the stage's work.
  assert.equal(isSatisfied(EXPOSE_STAGES, 'catalog', ctx({ hasSnapshot: true })), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'catalog', ctx({ hasSnapshot: true, selectedCount: 2 })), true);
});

test('Organize never gates entry (AI is optional) — reachable even with nothing selected', () => {
  const organize = EXPOSE_STAGES.find((s) => s.id === 'organize');
  assert.equal(organize?.enabled, undefined, 'Organize must not gate entry');
  assert.equal(canEnter(EXPOSE_STAGES, 'organize', ctx()), true);
});

test('Organize ✓ = the catalog has been organized — not a visit, not Catalog\'s selection', () => {
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx()), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx({ classified: true })), true);
  // Picking tables is Catalog\'s work; it must not tick Organize as well.
  assert.equal(isSatisfied(EXPOSE_STAGES, 'organize', ctx({ hasSnapshot: true, selectedCount: 2 })), false);
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
  // Being ABLE to review is not having created it: Review ticks only for a saved exposure.
  assert.equal(isSatisfied(EXPOSE_STAGES, 'review', ready), false);
  assert.equal(isSatisfied(EXPOSE_STAGES, 'review', { ...ready, saved: true }), true);
  // No selection → not ready even with a name + domain.
  assert.equal(canEnter(EXPOSE_STAGES, 'review', ctx({ hasName: true, hasDomains: true })), false);
});

test('a NEW exposure opens on Catalog with nothing ticked (there is no work yet)', () => {
  const s = initialStageState(EXPOSE_STAGES);
  assert.equal(s.current, 'catalog');
  assert.deepEqual(stageStatuses(EXPOSE_STAGES, s, ctx()).map((r) => r.done), [false, false, false, false]);
  // A snapshot and an organized catalog already on the connection tick only Organize (that work
  // IS done, per connection); the stages that are this exposure's own work stay un-ticked.
  const rail = stageStatuses(EXPOSE_STAGES, s, ctx({ hasSnapshot: true, classified: true }));
  assert.deepEqual(rail.map((r) => r.done), [false, true, false, false]);
  assert.equal(rail[0].label, 'Catalog: no tables picked yet');
});

test('a SAVED exposure opened for editing is ticked on open — no walking through the stages', () => {
  const saved = ctx({ hasSnapshot: true, selectedCount: 5, hasName: true, hasDomains: true, classified: true, saved: true });
  const rail = stageStatuses(EXPOSE_STAGES, initialStageState(EXPOSE_STAGES), saved);
  assert.deepEqual(rail.map((r) => r.done), [true, true, true, true]);
  // Drop the snapshot → the Catalog ✓ clears because its condition no longer holds.
  assert.equal(isDone(EXPOSE_STAGES, 'catalog', { ...saved, hasSnapshot: false }), false);
});

test('advancing past Assign without a name does NOT tick it', () => {
  // Selection is enough to enter Assign, but no name → Assign not satisfied, Review gated.
  const noName = ctx({ hasSnapshot: true, selectedCount: 2, hasName: false, hasDomains: true, classified: true });
  let s = initialStageState(EXPOSE_STAGES);
  s = advance(EXPOSE_STAGES, s, noName); // catalog → organize
  s = advance(EXPOSE_STAGES, s, noName); // organize → assign
  assert.equal(s.current, 'assign');
  const after = advance(EXPOSE_STAGES, s, noName); // assign → review? review not enterable (no name)
  assert.equal(after.current, 'assign', 'cannot advance to Review without a name');
  assert.equal(isDone(EXPOSE_STAGES, 'assign', noName), false);
  assert.equal(stageStatuses(EXPOSE_STAGES, after, noName)[2].label, 'Assign: needs a name and a domain');
});

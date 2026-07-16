/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Lifecycle copy + gating tests. The <ConfirmDialog> button is disabled by the
 * same `phraseSatisfied` gate exercised here and renders the same copy strings,
 * so pinning these pins the load-bearing behaviour (confirm fires only when the
 * gate passes; delete copy is permanent + names the backing resource; shared
 * artifacts require typing the name) without needing a DOM harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveCopy,
  archiveFolderCopy,
  deleteFolderCopy,
  deleteCopy,
  restoreVersionCopy,
  phraseSatisfied,
  affectsOthers,
  type ArtifactKind,
} from './lifecycle.ts';

test('folder archive copy names the item count + is light/reversible', () => {
  const c = archiveFolderCopy('Contracts', 3);
  assert.equal(c.danger, false);
  assert.equal(c.confirmPhrase, undefined);
  assert.match(c.body, /3 items/);
  assert.match(c.body, /restore the folder later/);
  // Singular grammar.
  assert.match(archiveFolderCopy('Solo', 1).body, /1 item\b/);
});

test('folder delete copy is danger, permanent, and cascades to the items inside', () => {
  const c = deleteFolderCopy('Contracts', 3);
  assert.equal(c.danger, true);
  assert.match(c.body, /permanently deletes/);
  assert.match(c.body, /all 3 items/);
  assert.match(c.body, /cannot be undone/);
});

test('archive copy is light + reversible (never danger, no type-to-confirm)', () => {
  const c = archiveCopy('Q3 revenue');
  assert.equal(c.danger, false);
  assert.equal(c.confirmPhrase, undefined);
  assert.match(c.title, /Archive .Q3 revenue./);
  assert.match(c.body, /restore it anytime/);
});

test('delete copy is danger, permanent, and names the backing resource per kind', () => {
  const backing: Record<ArtifactKind, RegExp> = {
    dataset: /Iceberg tables/,
    file: /stored file/,
    app: /running app and its repo/,
    agent: /repo and schedule/,
    dashboard: /Superset dashboard/,
    metric: /semantic layer/,
    connection: /stored credential/,
    knowledge: /search index/,
    bigbet: /bet and its plan/,
  };
  for (const kind of Object.keys(backing) as ArtifactKind[]) {
    const c = deleteCopy(kind, 'Thing', 'personal');
    assert.equal(c.danger, true, `${kind} delete must be danger`);
    assert.match(c.body, /permanently/i, `${kind} must say permanent`);
    assert.match(c.body, /cannot be undone/i, `${kind} must say irreversible`);
    assert.match(c.body, backing[kind], `${kind} must name its backing resource`);
  }
});

test('personal delete needs no phrase; shared/certified require typing the name', () => {
  assert.equal(affectsOthers('personal'), false);
  assert.equal(affectsOthers('shared'), true);
  assert.equal(affectsOthers('certified'), true);

  assert.equal(deleteCopy('dataset', 'Sales', 'personal').confirmPhrase, undefined);
  assert.equal(deleteCopy('dataset', 'Sales', 'shared').confirmPhrase, 'Sales');
  assert.equal(deleteCopy('metric', 'ARR', 'certified').confirmPhrase, 'ARR');
});

test('phraseSatisfied gates the confirm: empty gate always ok; typed must match (trimmed)', () => {
  // No gate → confirm always allowed (light archive / personal delete).
  assert.equal(phraseSatisfied(undefined, ''), true);
  // Gate present → only an exact (trimmed) match passes; cancel/blank does not fire.
  assert.equal(phraseSatisfied('Sales', ''), false);
  assert.equal(phraseSatisfied('Sales', 'sales'), false, 'case-sensitive to the name');
  assert.equal(phraseSatisfied('Sales', 'Sales'), true);
  assert.equal(phraseSatisfied('Sales', '  Sales  '), true, 'trims surrounding space');
});

test('restore-version copy confirms and promises reversibility', () => {
  const c = restoreVersionCopy('Dash', 4);
  assert.equal(c.danger, false);
  assert.match(c.title, /Restore version 4/);
  assert.match(c.body, /reversible/);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, personaFor, launcherFor } from '@tabs/home/lib/launcher';

test('the catalog has every golden path, each fully described', () => {
  const ids = PATHS.map((p) => p.id);
  for (const id of ['data', 'knowledge', 'connections', 'agents', 'software', 'metrics', 'dashboards']) {
    assert.ok(ids.includes(id as (typeof ids)[number]), `${id} present`);
  }
  for (const p of PATHS) {
    assert.ok(p.blurb.length > 0, `${p.id} has a one-line explainer`);
    assert.ok(p.createLabel.length > 0, `${p.id} has an action label`);
  }
});

test('persona derives from role + authoring activity (User vs Creator)', () => {
  assert.equal(personaFor('creator', false), 'user');
  assert.equal(personaFor('creator', true), 'creator');
  assert.equal(personaFor('builder', false), 'builder');
  assert.equal(personaFor('admin', false), 'admin');
});

test('every card carries a working action deep-link', () => {
  const cards = launcherFor('creator');
  assert.equal(cards.length, 7);
  for (const c of cards) {
    assert.ok(c.href.startsWith('/'), `${c.id} deep-links into a tab`);
    assert.ok(c.actionLabel.length > 0);
  }
});

test('Builder-gated paths are explained-but-dimmed for a Creator, actionable for a Builder', () => {
  const creator = launcherFor('creator');
  const builder = launcherFor('builder');
  const find = (cards: ReturnType<typeof launcherFor>, id: string) => cards.find((c) => c.id === id)!;

  // Connections is a Builder/Admin authoring surface.
  for (const id of ['connections']) {

    assert.equal(find(creator, id).canAct, false, `${id} dimmed for creator`);
    assert.ok(find(creator, id).dimmedReason, `${id} still explained for creator`);
    assert.equal(find(builder, id).canAct, true, `${id} actionable for builder`);
  }
  // Consumer paths are actionable for both (verb differs, not access).
  assert.equal(find(creator, 'data').canAct, true);
  assert.equal(find(builder, 'data').canAct, true);
});

test('a User sees Explore verbs; a Creator sees create verbs — different emphasis', () => {
  const user = launcherFor('user');
  const creator = launcherFor('creator');
  assert.equal(user.find((c) => c.id === 'data')!.actionLabel, 'Explore');
  assert.equal(creator.find((c) => c.id === 'data')!.actionLabel, 'Load data');
});

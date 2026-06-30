/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, personaFor, launcherFor } from './launcher.ts';

test('the catalog has all ten golden paths, each fully described', () => {
  const ids = PATHS.map((p) => p.id);
  for (const id of ['data', 'knowledge', 'connections', 'agents', 'software', 'science', 'metrics', 'dashboards', 'big-bets', 'marketplace']) {
    assert.ok(ids.includes(id as (typeof ids)[number]), `${id} present`);
  }
  for (const p of PATHS) {
    assert.ok(p.blurb.length > 0, `${p.id} has a one-line explainer`);
    assert.ok(p.createLabel.length > 0, `${p.id} has an action label`);
  }
  // The interview-decided Science copy.
  assert.equal(PATHS.find((p) => p.id === 'science')!.blurb, 'Train, run & monitor machine learning models.');
});

test('persona derives from role + authoring activity (User vs Creator)', () => {
  assert.equal(personaFor('participant', false), 'user');
  assert.equal(personaFor('participant', true), 'creator');
  assert.equal(personaFor('builder', false), 'builder');
  assert.equal(personaFor('admin', false), 'admin');
});

test('every card carries a working action deep-link AND a tutorial link', () => {
  const cards = launcherFor('creator');
  assert.equal(cards.length, 10);
  for (const c of cards) {
    assert.ok(c.href.startsWith('/'), `${c.id} deep-links into a tab`);
    assert.ok(c.tutorialHref.includes(`tutorial=${c.id}`), `${c.id} "How it works" → its tutorial`);
    assert.ok(c.actionLabel.length > 0);
  }
});

test('Builder-gated paths are explained-but-dimmed for a Creator, actionable for a Builder', () => {
  const creator = launcherFor('creator');
  const builder = launcherFor('builder');
  const find = (cards: ReturnType<typeof launcherFor>, id: string) => cards.find((c) => c.id === id)!;

  // Connections + Big Bets are Builder/Admin authoring surfaces.
  for (const id of ['connections', 'big-bets']) {
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
  // Marketplace always reads "Browse".
  assert.equal(user.find((c) => c.id === 'marketplace')!.actionLabel, 'Browse');
});

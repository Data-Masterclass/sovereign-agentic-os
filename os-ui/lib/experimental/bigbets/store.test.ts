/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Store-level tests for the parity rollout: DISPLAY-name rename (id FROZEN) and
 * folder move. Mirrors `lib/data/store.test.ts`'s renameDataset suite, adapted to a
 * big bet (no personal tier → folders are always domain-scoped; names are NOT unique).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetBets,
  createBet,
  getBet,
  moveBet,
  renameBet,
  listBetVersions,
  type CreateBetInput,
} from './store.ts';
import { BetError, type Principal } from './model.ts';

const sara: Principal = { id: 'sara', domains: ['sales'], role: 'builder' }; // owner
const salesAdmin: Principal = { id: 'dadmin', domains: ['sales'], role: 'domain_admin' };
const otherCreator: Principal = { id: 'nobody', domains: ['sales'], role: 'creator' };

beforeEach(() => { __resetBets(); });

function newBet(over: Partial<CreateBetInput> = {}): ReturnType<typeof createBet> {
  return createBet(sara, {
    name: 'Reduce churn',
    problem: { who: 'Retention', need: 'Cut at-risk churn', obstacle: '', impact: '' },
    pillarId: 'pillar_retention',
    targetValue: 1_000_000,
    goLive: '2026-12-31',
    ...over,
  });
}

// ------------------------------------------------------- rename: name + FROZEN id --

test('renameBet: changes the DISPLAY name but never the frozen id', () => {
  const bet = newBet();
  const idBefore = bet.id;
  const renamed = renameBet(bet.id, sara, 'Reduce churn v2');
  assert.equal(renamed.name, 'Reduce churn v2', 'display name changed');
  assert.equal(renamed.id, idBefore, 'id is the frozen identity — never moves on a rename');
  assert.equal(getBet(idBefore, sara).name, 'Reduce churn v2');
});

test('renameBet: snapshots the prior state to the version log', () => {
  const bet = newBet();
  assert.equal(listBetVersions(bet.id, sara).length, 0);
  renameBet(bet.id, sara, 'Renamed');
  const versions = listBetVersions(bet.id, sara);
  assert.equal(versions.length, 1, 'a rename records exactly one prior snapshot');
  assert.equal((versions[0].state as { name: string }).name, 'Reduce churn', 'snapshot holds the OLD name');
});

test('renameBet: owner allowed; an in-domain domain_admin allowed on a (shared) bet; a non-owner non-admin denied', () => {
  const bet = newBet();
  // Owner may rename.
  assert.equal(renameBet(bet.id, sara, 'By owner').name, 'By owner');
  // A big bet edits under the SHARED-artifact rule → an in-domain domain_admin may rename it.
  assert.equal(renameBet(bet.id, salesAdmin, 'By domain admin').name, 'By domain admin');
  // A bare creator who is not the owner may not.
  assert.throws(() => renameBet(bet.id, otherCreator, 'Hijack'), (e) => (e as BetError).status === 403);
});

test('renameBet: rejects an empty name (400) and is a no-op when unchanged', () => {
  const bet = newBet();
  assert.throws(() => renameBet(bet.id, sara, '   '), (e) => (e as BetError).status === 400);
  // No-op → no version churn.
  const same = renameBet(bet.id, sara, 'Reduce churn');
  assert.equal(same.name, 'Reduce churn');
  assert.equal(listBetVersions(bet.id, sara).length, 0, 'an unchanged name records no version');
});

test('renameBet: trims surrounding whitespace', () => {
  const bet = newBet();
  assert.equal(renameBet(bet.id, sara, '  Trimmed  ').name, 'Trimmed');
});

test('renameBet: a duplicate name is ALLOWED (bets carry no uniqueness rule)', () => {
  const a = newBet({ name: 'Alpha' });
  const b = newBet({ name: 'Beta' });
  // No 409 — big-bet names are not unique.
  assert.equal(renameBet(b.id, sara, 'Alpha').name, 'Alpha');
  assert.equal(getBet(a.id, sara).name, 'Alpha');
});

// ------------------------------------------------------------- folder move --

test('moveBet: sets the normalised folder and it survives a re-read', () => {
  const bet = newBet();
  assert.equal(bet.folder, '/', 'a fresh bet lives at the root');
  const moved = moveBet(bet.id, sara, 'q4/retention');
  assert.equal(moved.folder, '/q4/retention', 'the path is normalised (leading slash)');
  assert.equal(getBet(bet.id, sara).folder, '/q4/retention', 'the move persists');
});

test('moveBet: edit-scoped — a non-owner non-admin is denied 403 and nothing is written', () => {
  const bet = newBet();
  assert.throws(() => moveBet(bet.id, otherCreator, '/hijack'), (e) => (e as BetError).status === 403);
  assert.equal(getBet(bet.id, sara).folder, '/', 'a denied move leaves the folder untouched');
});

test('moveBet: an in-domain domain_admin may move a (shared) bet', () => {
  const bet = newBet();
  assert.equal(moveBet(bet.id, salesAdmin, '/governed').folder, '/governed');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetBets, createBet, getBet, archiveBet } from './store.ts';
import { BetError, type CreateBetInput, type Principal } from './model.ts';
import { bigbetsAdapter } from './folder-adapter.ts';

const sara: Principal = { id: 'sara', domains: ['sales'], role: 'builder' }; // owner
const saraAP = { id: 'sara', role: 'builder', domains: ['sales'] };
const stranger = { id: 'nobody', role: 'creator', domains: ['sales'] };

beforeEach(() => { __resetBets(); resetFolders(); });

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

// FLAT-LIST SCOPE SPLIT: listBets returns a flat array + a bet has no personal tier,
// so every bet maps to the DOMAIN lane and the personal lane is always empty. A cascade
// in a personal folder must therefore never see a domain bet.
test('a moved bet is found under its new folder in the DOMAIN scope only (never personal)', () => {
  const bet = newBet();
  bigbetsAdapter.moveItem(bet.id, saraAP, '/q4');
  assert.deepEqual(
    bigbetsAdapter.itemsUnderFolder(saraAP, 'domain', '/q4').map((i) => i.id),
    [bet.id],
  );
  assert.deepEqual(
    bigbetsAdapter.itemsUnderFolder(saraAP, 'personal', '/q4').map((i) => i.id),
    [],
    'a bet has no personal tier — the personal lane is empty',
  );
});

test('bigbets adapter itemsUnderFolder includes ARCHIVED members for the cascade', () => {
  const bet = newBet();
  bigbetsAdapter.moveItem(bet.id, saraAP, '/keep');
  archiveBet(bet.id, sara);
  assert.deepEqual(
    bigbetsAdapter.itemsUnderFolder(saraAP, 'domain', '/keep').map((i) => i.id),
    [bet.id],
    'the archived bet is still enumerated so restore/delete can cascade to it',
  );
});

test('adapter ops are edit-scoped — a non-owner non-admin move throws 403', () => {
  const bet = newBet();
  assert.throws(() => bigbetsAdapter.moveItem(bet.id, stranger, '/hijack'), (e) => (e as BetError).status === 403);
  assert.equal(getBet(bet.id, sara).folder, '/', 'a denied move leaves the folder untouched');
});

test('adapter move re-parents; archive then restore round-trips', () => {
  const bet = newBet();
  bigbetsAdapter.moveItem(bet.id, saraAP, '/wave1');
  bigbetsAdapter.archiveItem(bet.id, saraAP);
  assert.equal(getBet(bet.id, sara).status, 'archived');
  bigbetsAdapter.restoreItem(bet.id, saraAP);
  assert.equal(getBet(bet.id, sara).status, 'active');
  assert.equal(getBet(bet.id, sara).folder, '/wave1', 'the folder survives the archive/restore round-trip');
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - the Chat view's ordering, edit body and storyless offer
 * USER STORY: As a business user I want open cards first, my edit sent with the version I edited, and the "create a
 *             story from this change" offer to start from the card's own summary.
 * ARCHITECTURE: Pure helpers of chat/model.ts (the .tsx view cannot be imported by a test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editBody, lightRows, orderCards, storylessPrefill, type CardView } from './model.ts';

const card = (id: string, status: CardView['status'], createdAt: string, decidedAt?: string): CardView => ({
  id, appId: 'a', classification: 'new-story', rationale: '', confidence: 1, alternatives: [], source: 'chat', posthoc: false, requestedBy: 'u', status, createdAt,
  ...(decidedAt ? { decidedAt } : {}),
  change: { writes: [{ path: 'stories/EP-1-a/US-1-b.md', content: 'old' }, { path: 'stories/EP-1-a/_epic.md', content: 'e' }], deletes: [], summary: 'code changed in abc without a story: src/a.ts' },
  rev: 'r1', needsRevert: false, touched: [],
});

test('open cards first (newest first), decided ones after, bounded', () => {
  const o = orderCards([card('a', 'approved', '1', '5'), card('b', 'pending', '2'), card('c', 'pending', '3'), card('d', 'rejected', '4', '6')], 1);
  assert.deepEqual(o.pending.map((c) => c.id), ['c', 'b']);
  assert.deepEqual(o.decided.map((c) => c.id), ['d']);
});

test('an edit carries the rev it was made on and only the edited contents change', () => {
  const b = editBody(card('a', 'pending', '1'), { 'stories/EP-1-a/US-1-b.md': 'new' });
  assert.equal(b.rev, 'r1');
  assert.deepEqual(b.change.writes.map((w) => w.content), ['new', 'e']);
  assert.deepEqual(b.change.deletes, []);
});

test('the storyless offer starts from the card summary; lights are listed in story-id order', () => {
  assert.match(storylessPrefill(card('a', 'pending', '1')), /without a story: src\/a\.ts/);
  const rows = lightRows({ 'US-10': { light: 'green', status: 'built', criteria: [] }, 'US-2': { light: 'untested', status: 'agreed', criteria: [] } });
  assert.deepEqual(rows.map((r) => r.id), ['US-2', 'US-10']);
});

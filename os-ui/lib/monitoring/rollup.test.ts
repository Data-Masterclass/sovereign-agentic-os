/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worst, byAttention, summarize, pickAttention } from './rollup.ts';
import type { HealthItem } from './types.ts';

function item(id: string, health: HealthItem['health'], ts?: string): HealthItem {
  return { id, lens: 'runs', title: id, health, detail: '', owner: 'o', domain: 'd', ts, source: 'mock' };
}

test('worst-of roll-up: red beats amber beats green; empty → unknown', () => {
  assert.equal(worst(['green', 'amber', 'red']), 'red');
  assert.equal(worst(['green', 'amber']), 'amber');
  assert.equal(worst(['green', 'green']), 'green');
  assert.equal(worst([]), 'unknown');
});

test('attention-first ordering: red, then amber, then green (NOT a wall of green)', () => {
  const sorted = [item('g', 'green'), item('r', 'red'), item('a', 'amber')].sort(byAttention);
  assert.deepEqual(sorted.map((i) => i.id), ['r', 'a', 'g']);
});

test('ties broken by recency (most recent first)', () => {
  const older = item('old', 'red', '2026-06-30T01:00:00Z');
  const newer = item('new', 'red', '2026-06-30T05:00:00Z');
  const sorted = [older, newer].sort(byAttention);
  assert.deepEqual(sorted.map((i) => i.id), ['new', 'old']);
});

test('summarize: worst-of health + per-health counts', () => {
  const s = summarize('runs', [item('a', 'green'), item('b', 'red'), item('c', 'green')]);
  assert.equal(s.health, 'red');
  assert.equal(s.counts.green, 2);
  assert.equal(s.counts.red, 1);
  assert.equal(s.items[0].health, 'red'); // sorted attention-first
});

test('empty lens rolls up to unknown', () => {
  assert.equal(summarize('cost', []).health, 'unknown');
});

test('pickAttention: only red/amber, worst-first, capped', () => {
  const got = pickAttention(
    [item('g', 'green'), item('r', 'red'), item('a', 'amber'), item('g2', 'green')],
    8,
  );
  assert.deepEqual(got.map((i) => i.id), ['r', 'a']);
  assert.equal(pickAttention([item('r1', 'red'), item('r2', 'red'), item('r3', 'red')], 2).length, 2);
});

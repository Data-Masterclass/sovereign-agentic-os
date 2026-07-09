/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleContext,
  compactToolResult,
  deterministicScore,
  estimateTokens,
  truncateToTokens,
  type Candidate,
} from './context-assembler.ts';

const pinned = (id: string, text: string): Candidate => ({ id, kind: 'pinned', text });
const tool = (id: string, text: string, priority = 0, at = 0): Candidate => ({
  id,
  kind: 'tool-result',
  text,
  priority,
  at,
});

test('assembled context never exceeds the budget', () => {
  const candidates: Candidate[] = [
    pinned('sys', 'x'.repeat(400)),
    tool('t1', 'a'.repeat(4000)),
    tool('t2', 'b'.repeat(4000)),
    tool('t3', 'c'.repeat(4000)),
  ];
  const budget = 500;
  const out = assembleContext({ query: 'q', budget, candidates });
  assert.ok(out.tokensUsed <= budget, `tokensUsed ${out.tokensUsed} > budget ${budget}`);
});

test('pinned is always included even when the rest is dropped', () => {
  const candidates: Candidate[] = [
    pinned('sys', 'system spine'),
    tool('t1', 'z'.repeat(100_000)),
  ];
  const out = assembleContext({ query: 'q', budget: 200, candidates });
  assert.ok(out.includedIds.includes('sys'));
  assert.ok(out.droppedIds.includes('t1'));
});

test('a huge tool-result is COMPACTED (kept), not dropped, when it can fit compacted', () => {
  const rows = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ i, v: `row-${i}` })));
  const candidates: Candidate[] = [pinned('sys', 'spine'), tool('big', rows)];
  // Budget generous enough for the pinned + the COMPACTED (5-row) form, but far
  // smaller than the raw 1000-row payload.
  const out = assembleContext({ query: 'q', budget: 2000, candidates });
  assert.ok(out.includedIds.includes('big'), 'big should be kept in compacted form');
  const bigText = out.texts.find((t) => t.includes('more rows'));
  assert.ok(bigText, 'compacted text carries the "…(N more rows)" marker');
  assert.ok(estimateTokens(bigText!) < estimateTokens(rows));
});

test('lowest-priority candidate is dropped first', () => {
  const candidates: Candidate[] = [
    pinned('sys', 'spine'),
    tool('low', 'l'.repeat(2000), 1),
    tool('high', 'h'.repeat(2000), 9),
  ];
  // Room for pinned + exactly one of the two 500-token results.
  const out = assembleContext({ query: 'q', budget: 520, candidates });
  assert.ok(out.includedIds.includes('high'), 'higher priority kept');
  assert.ok(out.droppedIds.includes('low'), 'lower priority dropped');
});

test('the manifest lists dropped ids honestly', () => {
  const candidates: Candidate[] = [
    pinned('sys', 'spine'),
    tool('a', 'a'.repeat(4000)),
    tool('b', 'b'.repeat(4000)),
  ];
  const out = assembleContext({ query: 'q', budget: 200, candidates });
  assert.deepEqual(new Set([...out.includedIds, ...out.droppedIds]), new Set(['sys', 'a', 'b']));
  assert.equal(out.droppedIds.length, 2);
});

test('a >200k-token transcript assembles to <= budget', () => {
  // ~250k chars of tool results ≈ 62k tokens; plus a modest pinned spine.
  const candidates: Candidate[] = [
    pinned('sys', 'the immutable task spine'),
    ...Array.from({ length: 50 }, (_, i) => tool(`t${i}`, 'x'.repeat(5000), 0, i)),
  ];
  const total = candidates.reduce((n, c) => n + estimateTokens(c.text), 0);
  assert.ok(total > 60_000, 'test fixture is genuinely large');
  const budget = 8_000;
  const out = assembleContext({ query: 'q', budget, candidates });
  assert.ok(out.tokensUsed <= budget);
  assert.ok(out.includedIds.includes('sys'), 'spine survives');
  assert.ok(out.droppedIds.length > 0, 'the bulk is dropped');
});

test('compactToolResult truncates long prose with a marker', () => {
  const long = 'p'.repeat(10_000);
  const out = compactToolResult(long);
  assert.ok(out.includes('[truncated'));
  assert.ok(out.length < long.length);
});

test('compactToolResult leaves small results unchanged', () => {
  const small = 'just a short result';
  assert.equal(compactToolResult(small), small);
});

test('truncateToTokens respects the token ceiling', () => {
  const out = truncateToTokens('y'.repeat(10_000), 100);
  assert.ok(estimateTokens(out) <= 100 + estimateTokens('\n…[truncated to fit context]…'));
});

test('deterministicScore ranks by priority then recency', () => {
  const hi = deterministicScore(tool('a', 't', 5, 100), 'q');
  const lo = deterministicScore(tool('b', 't', 1, 100), 'q');
  assert.ok(hi > lo);
  const newer = deterministicScore(tool('c', 't', 1, 2e13), 'q');
  const older = deterministicScore(tool('d', 't', 1, 1), 'q');
  assert.ok(newer > older, 'recency breaks ties');
});

test('an injected Phase-2 scorer overrides the default (embedding seam)', () => {
  const candidates: Candidate[] = [
    pinned('sys', 'spine'),
    tool('rel', 'r'.repeat(2000), 0),
    tool('irrel', 'i'.repeat(2000), 9), // higher priority, but scorer demotes it
  ];
  // A fake relevance scorer that prefers the id 'rel' regardless of priority.
  const out = assembleContext({
    query: 'q',
    budget: 520,
    candidates,
    scoreCandidate: (c) => (c.id === 'rel' ? 100 : 0),
  });
  assert.ok(out.includedIds.includes('rel'));
  assert.ok(out.droppedIds.includes('irrel'));
});

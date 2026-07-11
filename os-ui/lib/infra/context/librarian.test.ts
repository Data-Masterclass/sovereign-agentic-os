/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, type Candidate } from './context-assembler.ts';
import {
  curateContext,
  curateThenAssemble,
  type CurateCandidate,
  type EmbedFn,
} from './librarian.ts';

/**
 * A DETERMINISTIC keyword embedder for tests. Each text is embedded as a small
 * one-hot-ish vector over a fixed vocabulary; cosine similarity is then high when the
 * `need` and a chunk share keywords and low when they don't. Records call count so we
 * can assert the under-budget path embeds NOTHING.
 */
const VOCAB = ['scorecard', 'campaign', 'roas', 'weather', 'recipe', 'sports', 'need'];
function makeEmbed(): EmbedFn & { calls: () => number } {
  let calls = 0;
  const fn = (async (texts: string[]) => {
    calls += 1;
    return texts.map((t) => {
      const lc = t.toLowerCase();
      return VOCAB.map((w) => (lc.includes(w) ? 1 : 0));
    });
  }) as EmbedFn & { calls: () => number };
  fn.calls = () => calls;
  return fn;
}

const tool = (id: string, text: string): CurateCandidate => ({ id, kind: 'tool-result', text });
const pinned = (id: string, text: string): CurateCandidate => ({ id, kind: 'pinned', text });

/** A big text so a chunk genuinely costs tokens (used to force over-budget). */
function big(word: string, n = 2000): string {
  return `${word} `.repeat(n);
}

test('under-budget → all kept, embed NOT called, curated:false', async () => {
  const embed = makeEmbed();
  const candidates: CurateCandidate[] = [tool('a', 'small a'), tool('b', 'small b')];
  const res = await curateContext({ candidates, budget: 100_000, need: 'anything', embed });
  assert.equal(res.curated, false);
  assert.equal(res.fallback, 'under-budget');
  assert.equal(res.candidates.length, 2);
  assert.equal(embed.calls(), 0, 'no embedding on the common under-budget path');
});

test('over-budget → pinned + predecessor kept full; low-relevance filler dropped; high beats low', async () => {
  const embed = makeEmbed();
  const sys = pinned('sys', 'SYSTEM PROMPT (must stay)');
  const pred: CurateCandidate = { ...tool('pred', big('scorecard campaign roas')), predecessor: true };
  const hi = tool('hi', big('scorecard campaign roas'));
  const lo = tool('lo', big('weather recipe sports'));
  // Budget fits sys + pred + hi with slack, but NOT lo on top → lo must be dropped.
  const budget =
    estimateTokens(sys.text) +
    estimateTokens(pred.text) +
    estimateTokens(hi.text) +
    50;
  const candidates: CurateCandidate[] = [sys, pred, hi, lo];
  const need = 'scorecard campaign roas — recommend budget by campaign';
  const res = await curateContext({ candidates, budget, need, embed });

  assert.equal(res.curated, true, 'actively curated when over budget with an embedder');
  const keptIds = res.candidates.map((c) => c.id);
  assert.ok(keptIds.includes('sys'), 'pinned kept');
  assert.ok(keptIds.includes('pred'), 'predecessor kept full');
  // The relevant chunk beats the irrelevant filler; filler is dropped.
  assert.ok(keptIds.includes('hi'), 'high-relevance chunk kept');
  const loTrace = res.trace.find((t) => t.id === 'lo');
  assert.equal(loTrace?.action, 'dropped', 'low-relevance filler dropped');
});

test('embed throws → passthrough fallback, no throw', async () => {
  const throwing: EmbedFn = async () => {
    throw new Error('embedder down');
  };
  const candidates: CurateCandidate[] = [
    tool('a', big('scorecard', 1500)),
    tool('b', big('weather', 1500)),
  ];
  const budget = estimateTokens(big('x', 500)); // over budget
  const res = await curateContext({ candidates, budget, need: 'scorecard', embed: throwing });
  assert.equal(res.curated, false);
  assert.equal(res.fallback, 'embed-error');
  assert.equal(res.candidates.length, 2, 'pool handed back untouched');
});

test('no embedder → passthrough fallback', async () => {
  const candidates: CurateCandidate[] = [tool('a', big('x', 1500)), tool('b', big('y', 1500))];
  const budget = estimateTokens(big('x', 200));
  const res = await curateContext({ candidates, budget, need: 'x' });
  assert.equal(res.curated, false);
  assert.equal(res.fallback, 'no-embedder');
  assert.equal(res.candidates.length, 2);
});

test('a 40-row scorecard predecessor survives curation IN FULL for a matching need; unrelated filler dropped', async () => {
  const embed = makeEmbed();
  const rows = Array.from({ length: 40 }, (_, i) => ({
    campaign: `campaign-${i}`,
    roas: (i % 5) + 1,
    label: 'scorecard',
  }));
  const scorecard = JSON.stringify(rows);
  const candidates: CurateCandidate[] = [
    { ...tool('scorecard', scorecard), predecessor: true },
    tool('filler', big('weather recipe sports', 1500)),
  ];
  // Budget large enough for the whole scorecard but NOT the filler on top.
  const budget = estimateTokens(scorecard) + 50;
  const need = 'recommend budget per campaign from the scorecard (roas by campaign)';
  const res = await curateContext({ candidates, budget, need, embed });

  const kept = res.candidates.find((c) => c.id === 'scorecard');
  assert.ok(kept, 'scorecard survived');
  assert.equal(kept!.text, scorecard, 'scorecard kept BYTE-FOR-BYTE (all 40 rows, no compaction)');
  const parsed = JSON.parse(kept!.text) as unknown[];
  assert.equal(parsed.length, 40, 'all 40 rows present');
  const fillerTrace = res.trace.find((t) => t.id === 'filler');
  assert.equal(fillerTrace?.action, 'dropped', 'unrelated filler dropped to make room');
});

test('curateThenAssemble: under-budget passes through to the sync packer, curated:false', async () => {
  const embed = makeEmbed();
  const candidates: Candidate[] = [
    { id: 'sys', kind: 'pinned', text: 'system' },
    { id: 'e', kind: 'tool-result', text: 'evidence rows' },
  ];
  const res = await curateThenAssemble({ need: 'q', budget: 100_000, candidates, embed });
  assert.equal(res.curated, false);
  assert.ok(res.includedIds.includes('sys'), 'assembled context includes pinned');
  assert.ok(res.tokensUsed <= res.budget, 'packer honoured the budget');
  assert.equal(embed.calls(), 0);
});

test('curateThenAssemble: over-budget curates then packs, pinned always survives', async () => {
  const embed = makeEmbed();
  const candidates: Candidate[] = [
    { id: 'sys', kind: 'pinned', text: 'SYSTEM' },
    { id: 'hi', kind: 'tool-result', text: big('scorecard campaign roas', 1500) },
    { id: 'lo', kind: 'tool-result', text: big('weather recipe sports', 1500) },
  ];
  const budget = estimateTokens(big('x', 1800));
  const res = await curateThenAssemble({
    need: 'scorecard campaign roas',
    budget,
    candidates,
    embed,
  });
  assert.equal(res.curated, true);
  assert.ok(res.includedIds.includes('sys'), 'pinned survives the whole pipeline');
  assert.ok(res.tokensUsed <= res.budget, 'final packed context never exceeds budget');
});

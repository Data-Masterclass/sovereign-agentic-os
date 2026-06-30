/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type KnowledgeUnit, type Provenance } from './chunk.ts';
import { type Scored } from './retrieve-core.ts';
import { buildContextPack, estimateTokens, renderContextPack } from './context-pack.ts';

function prov(over: Partial<Provenance> = {}): Provenance {
  return {
    domain: 'sales', workflowId: 'w', stepId: null, type: 'workflow', actor: null,
    owner: 'amir', version: '1', visibility: 'Shared', updatedAt: new Date().toISOString(),
    trust: 0.7, authority: 0.8, ...over,
  };
}
function unit(id: string, text: string): KnowledgeUnit {
  return { id, title: id, text, provenance: prov() };
}
function scored(id: string, text: string, score: number): Scored {
  return { unit: unit(id, text), relevance: score, score };
}

test('estimateTokens ~ chars/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(40)), 10);
});

test('pinned content (hard rules, domain, steps) is always included + ordered', () => {
  const pack = buildContextPack({
    hardRules: [unit('hr1', 'Error < 0.1%')],
    domainCard: [unit('d1', 'Sales domain card')],
    workflowSteps: [unit('s1', 'Step one'), unit('s2', 'Step two')],
    retrieved: [],
    budget: 1000,
  });
  assert.equal(pack.items[0].kind, 'hard-rule');
  assert.equal(pack.items[1].kind, 'domain');
  assert.equal(pack.items[2].kind, 'workflow-step');
  assert.equal(pack.dropped.length, 0);
});

test('retrieved evidence fills the remaining budget in rank order; rest dropped', () => {
  const big = 'x'.repeat(400); // 100 tokens each
  const pack = buildContextPack({
    hardRules: [],
    domainCard: [],
    workflowSteps: [unit('s', 'y'.repeat(40))], // 10 tokens pinned
    retrieved: [scored('e1', big, 0.9), scored('e2', big, 0.8), scored('e3', big, 0.7)],
    budget: 220, // 10 pinned + room for ~2 evidence (200) → 3rd dropped
  });
  const keptIds = pack.items.filter((i) => i.source === 'retrieved').map((i) => i.id);
  assert.deepEqual(keptIds, ['e1', 'e2']);
  assert.deepEqual(pack.dropped.map((d) => d.id), ['e3']);
  assert.ok(pack.totalTokens <= pack.budget);
});

test('pinned is kept even when it exceeds budget (correctness over budget)', () => {
  const pack = buildContextPack({
    hardRules: [unit('hr', 'z'.repeat(4000))], // 1000 tokens
    domainCard: [],
    workflowSteps: [],
    retrieved: [scored('e1', 'evidence', 0.9)],
    budget: 100,
  });
  assert.equal(pack.items.filter((i) => i.kind === 'hard-rule').length, 1);
  // No room left → evidence dropped.
  assert.equal(pack.items.some((i) => i.source === 'retrieved'), false);
  assert.equal(pack.dropped.length, 1);
});

test('retrieved items already pinned are not duplicated into the pack', () => {
  const shared = unit('s1', 'Step one');
  const pack = buildContextPack({
    hardRules: [],
    domainCard: [],
    workflowSteps: [shared],
    retrieved: [{ unit: shared, relevance: 0.9, score: 0.9 }, scored('e1', 'fresh evidence', 0.8)],
    budget: 1000,
  });
  const ids = pack.items.map((i) => i.id);
  assert.equal(ids.filter((x) => x === 's1').length, 1, 's1 should appear once (pinned only)');
  assert.ok(ids.includes('e1'));
});

test('renderContextPack tags items with kind + citation handle', () => {
  const pack = buildContextPack({
    hardRules: [unit('hr1', 'Never skip sign-off')],
    domainCard: [],
    workflowSteps: [],
    retrieved: [scored('e1', 'a tacit note', 0.9)],
    budget: 1000,
  });
  const rendered = renderContextPack(pack);
  assert.ok(rendered.includes('HARD RULE (enforced)'));
  assert.ok(rendered.includes('[cite:hr1]'));
  assert.ok(rendered.includes('[cite:e1]'));
});

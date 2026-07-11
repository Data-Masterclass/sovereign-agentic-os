/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRNode } from '../langgraph-compile.ts';
import type { ToolSpec } from '@/lib/assistant/agentic';
import { resolveNodeModel, type AgenticGraphDeps } from './agentic-graph.ts';
import { classifyModelNeed } from '../routing.ts';

const FAST = 'sovereign-default';
const REASONING = 'sovereign-reasoning';

function spec(name: string): ToolSpec {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

function node(over: Partial<IRNode> = {}): IRNode {
  return {
    id: 'agent',
    kind: 'react',
    prompt: '',
    memory: '',
    tools: [],
    model: null,
    supervisor: false,
    members: [],
    ...over,
  };
}

function deps(tools: string[], over: Partial<AgenticGraphDeps> = {}): AgenticGraphDeps {
  return {
    llm: async () => ({ content: '', toolCalls: [] }),
    toolSpecsFor: () => tools.map(spec),
    callTool: async () => ({ text: 'ok', isError: false }),
    preamble: 'p',
    reasoningModel: REASONING,
    execModel: FAST,
    ...over,
  };
}

test('read-only tools resolve to the FAST tier', () => {
  const r = resolveNodeModel(node({ id: 'performance_analyst' }), deps(['query_data', 'search_knowledge']));
  assert.equal(r.model, FAST);
  assert.equal(r.tier, 'fast');
  assert.match(r.reason, /read-only/);
  assert.match(r.reason, /query_data/);
});

test('a node with ZERO tools resolves to the REASONING tier (pure synthesis)', () => {
  const r = resolveNodeModel(node({ id: 'recommender' }), deps([]));
  assert.equal(r.model, REASONING);
  assert.equal(r.tier, 'reasoning');
  assert.match(r.reason, /no tools/);
});

test('any write/decide tool forces the REASONING tier', () => {
  const r = resolveNodeModel(node({ id: 'deployer' }), deps(['query_data', 'create_software']));
  assert.equal(r.model, REASONING);
  assert.equal(r.tier, 'reasoning');
  assert.match(r.reason, /write\/decide/);
});

test('keyword tiebreak: a read-only node whose role says "evaluate" goes REASONING', () => {
  const r = resolveNodeModel(node({ id: 'evaluator', prompt: 'Evaluate and score each campaign against the rubric.' }), deps(['query_data']));
  assert.equal(r.tier, 'reasoning');
  assert.equal(r.model, REASONING);
});

test('an explicitly PINNED model is honored over Auto', () => {
  // Pin the reasoning model on an otherwise-fast (read-only) node → pin wins.
  const r = resolveNodeModel(node({ id: 'analyst', model: REASONING }), deps(['query_data']));
  assert.equal(r.model, REASONING);
  assert.equal(r.tier, 'reasoning');
  assert.match(r.reason, /pinned/);
});

test("the 'auto' sentinel is treated as unset (classified, not pinned)", () => {
  const r = resolveNodeModel(node({ id: 'analyst', model: 'auto' }), deps(['query_data']));
  assert.equal(r.model, FAST);
  assert.equal(r.tier, 'fast');
  assert.doesNotMatch(r.reason, /pinned/);
});

test('classifyModelNeed reason is always populated', () => {
  for (const tools of [[], ['query_data'], ['create_software']]) {
    const { reason } = classifyModelNeed(tools, 'agent');
    assert.ok(reason.length > 0, `reason populated for ${JSON.stringify(tools)}`);
  }
});

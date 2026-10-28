/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Agents Choose-Context model (lib/agents/choose-context-meta.ts) — the pure
 * seven-type descriptor list the Grant stage renders: order, grant-channel wiring (reusing
 * resource-groups), the collapsed Plan Items row, and create-new modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CONTEXT_TYPES,
  AGENT_CONTEXT_META,
  agentContextGrantedCount,
  grantedSummary,
} from '@/lib/agents/choose-context-meta';

test('types: ordered Data · Metrics · Files · Knowledge · Connections · Workflows · Plan (mirrors Software)', () => {
  assert.deepEqual(AGENT_CONTEXT_TYPES, ['data', 'metrics', 'files', 'knowledge', 'connections', 'workflows', 'plan']);
});

test('every type has a descriptor with a label + blurb', () => {
  for (const t of AGENT_CONTEXT_TYPES) {
    const meta = AGENT_CONTEXT_META[t];
    assert.ok(meta, `missing meta for ${t}`);
    assert.equal(typeof meta.label, 'string');
    assert.ok(meta.label.length > 0);
    assert.ok(meta.blurb.length > 0);
  }
});

test('the flat/foldered types bind to exactly one resource member; Plan collapses three', () => {
  // data/knowledge/files → foldered members; connections/metrics/workflows → single members.
  for (const t of ['data', 'metrics', 'files', 'knowledge', 'connections', 'workflows'] as const) {
    assert.ok(AGENT_CONTEXT_META[t].member, `${t} should carry one member`);
    assert.equal(AGENT_CONTEXT_META[t].members, undefined);
  }
  // Plan Items = Operating Model · Strategy · Big Bets collapsed into one row.
  const plan = AGENT_CONTEXT_META.plan;
  assert.equal(plan.member, undefined);
  assert.equal(plan.members?.length, 1);
  // Every plan sub-member writes the SAME `plan` grant list.
  for (const m of plan.members!) assert.equal(m.field, 'plan');
});

test('Workflows uses the knowledge feed narrowed to the workflow family', () => {
  const m = AGENT_CONTEXT_META.workflows.member!;
  assert.equal(m.feedKind, 'knowledge');
  assert.equal(m.idFamily, 'workflow');
});

test('Knowledge uses the knowledge feed narrowed to the knowledge (non-workflow) family', () => {
  const m = AGENT_CONTEXT_META.knowledge.member!;
  assert.equal(m.feedKind, 'knowledge');
  assert.equal(m.idFamily, 'knowledge');
});

test('create-new: data/files/knowledge/connections deep-link; metrics is derived; workflows/plan have none', () => {
  for (const t of ['data', 'files', 'knowledge', 'connections'] as const) {
    assert.equal(AGENT_CONTEXT_META[t].createMode, 'deep-link');
    assert.ok(AGENT_CONTEXT_META[t].createTab, `${t} deep-link needs a createTab`);
  }
  assert.equal(AGENT_CONTEXT_META.metrics.createMode, 'derived');
  assert.equal(AGENT_CONTEXT_META.workflows.createMode, undefined);
  assert.equal(AGENT_CONTEXT_META.plan.createMode, undefined);
});

test('agentContextGrantedCount: sums per-field for a single member, and once for the plan row', () => {
  const counts: Record<string, number> = { data: 2, knowledge: 1, plan: 5, connections: 0 };
  const by = (field: string | undefined) => counts[field ?? ''] ?? 0;
  assert.equal(agentContextGrantedCount('data', by), 2);
  assert.equal(agentContextGrantedCount('connections', by), 0);
  // Plan Items counts the shared `plan` list ONCE (its sub-members share it).

  assert.equal(agentContextGrantedCount('plan', by), 5);
});

test('grantedSummary re-export matches the shared core copy', () => {
  assert.equal(grantedSummary(0), 'Nothing granted yet');
  assert.equal(grantedSummary(3), '3 already available to this app');
});

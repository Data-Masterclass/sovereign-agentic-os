/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_MEMBERS,
  RESOURCE_SECTIONS,
  membersOf,
  isWorkflowId,
} from './resource-groups.ts';

/**
 * The two-section grouping of "What your team can use": Plan Items (Strategy · Big
 * Bets · Operating Manual · Workflows) and Context (Knowledge · Files · Data ·
 * Connections · Metrics), with Workflows a SEPARATE member from Knowledge.
 */

test('Plan Items are Strategy · Big Bets · Operating Manual · Workflows, in order', () => {
  const labels = membersOf('plan').map((m) => m.label);
  assert.deepEqual(labels, ['Strategy', 'Big Bets', 'Operating Manual', 'Workflows']);
});

test('Context is Knowledge · Files · Data · Connections · Metrics, in order', () => {
  const labels = membersOf('context').map((m) => m.label);
  assert.deepEqual(labels, ['Knowledge', 'Files', 'Data', 'Connections', 'Metrics']);
});

test('Workflows is its OWN member, separate from Knowledge', () => {
  const workflows = RESOURCE_MEMBERS.find((m) => m.key === 'workflows')!;
  const knowledge = RESOURCE_MEMBERS.find((m) => m.key === 'knowledge')!;
  assert.notEqual(workflows.section, knowledge.section); // plan vs context
  assert.equal(workflows.label, 'Workflows');
  assert.equal(knowledge.label, 'Knowledge');
  // Both draw from the shared `knowledge` feed but each filters to its own family.
  assert.equal(workflows.feedKind, 'knowledge');
  assert.equal(knowledge.feedKind, 'knowledge');
  assert.equal(workflows.idFamily, 'workflow');
  assert.equal(knowledge.idFamily, 'knowledge');
});

test('the wireable Context members carry a grant field + feed kind', () => {
  for (const key of ['knowledge', 'files', 'data', 'connections', 'metrics']) {
    const m = RESOURCE_MEMBERS.find((x) => x.key === key)!;
    assert.equal(m.wireable, true, `${key} should be wireable`);
    assert.ok(m.field, `${key} needs a grant field`);
    assert.ok(m.feedKind, `${key} needs a feed kind`);
  }
});

test('Operating Manual is genuinely wireable via the plan grant list + operating-manual feed', () => {
  const m = RESOURCE_MEMBERS.find((x) => x.key === 'operating-manual')!;
  assert.equal(m.wireable, true);
  assert.equal(m.field, 'plan');
  assert.equal(m.feedKind, 'operating-manual');
});

test('Strategy · Big Bets are now genuinely wireable via the plan grant list + their feeds', () => {
  const strategy = RESOURCE_MEMBERS.find((x) => x.key === 'strategy')!;
  assert.equal(strategy.wireable, true);
  assert.equal(strategy.field, 'plan');
  assert.equal(strategy.feedKind, 'strategy');

  const bigbets = RESOURCE_MEMBERS.find((x) => x.key === 'bigbets')!;
  assert.equal(bigbets.wireable, true);
  assert.equal(bigbets.field, 'plan');
  assert.equal(bigbets.feedKind, 'big-bets');

  // No placeholder note lingers now that they are real pickers.
  assert.equal(strategy.note, undefined);
  assert.equal(bigbets.note, undefined);
});

test('isWorkflowId splits the shared knowledge feed', () => {
  assert.equal(isWorkflowId('wf_123'), true);
  assert.equal(isWorkflowId('pk_123'), false);
  assert.equal(isWorkflowId('anything_else'), false);
});

test('the two sections are Plan Items then Context', () => {
  assert.deepEqual(RESOURCE_SECTIONS.map((s) => s.title), ['Plan Items', 'Context']);
});

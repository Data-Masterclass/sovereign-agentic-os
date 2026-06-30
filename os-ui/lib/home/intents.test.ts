/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsk, deriveName } from './intents.ts';

test('"build a dashboard of churn by region" → scaffold a dashboard draft', () => {
  const i = classifyAsk('build a dashboard of churn by region');
  assert.equal(i.kind, 'scaffold');
  if (i.kind === 'scaffold') {
    assert.equal(i.type, 'dashboard');
    assert.ok(i.name.toLowerCase().includes('churn'));
  }
});

test('"create an agent that drafts renewal emails" → scaffold an agent draft', () => {
  const i = classifyAsk('create an agent that drafts renewal emails');
  assert.equal(i.kind, 'scaffold');
  if (i.kind === 'scaffold') assert.equal(i.type, 'agent');
});

test('promote/certify ALWAYS stay human — never a scaffold', () => {
  for (const p of [
    'promote my churn dashboard to shared',
    'certify the revenue metric',
    'publish this agent to the marketplace',
    'make it certified',
  ]) {
    const i = classifyAsk(p);
    assert.equal(i.kind, 'human-gate', `"${p}" is human-gated`);
    if (i.kind === 'human-gate') assert.ok(i.tab.startsWith('/'));
  }
});

test('a plain question is answered, not actioned', () => {
  assert.equal(classifyAsk('what is a golden path?').kind, 'answer');
  assert.equal(classifyAsk('').kind, 'answer');
});

test('deriveName makes a sensible, capped draft name', () => {
  assert.equal(deriveName('build a dashboard of churn by region', 'dashboard'), 'Churn by region');
  assert.ok(deriveName('x'.repeat(200), 'metric').length <= 61);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileConnectionProfile,
  exposedTools,
  evaluateRule,
  decide,
  GENERIC_REGO,
} from './capability-compiler.ts';

const TOOLS = [
  { name: 'read_account', mode: 'Read' as const, write: false },
  { name: 'update_amount', mode: 'Write-bounded' as const, write: true, maxAmount: 50000 },
  { name: 'create_page', mode: 'Write-approval' as const, write: true },
  { name: 'mass_update', mode: 'Off' as const, write: true },
  { name: 'delete_record', mode: 'Blocked' as const, write: true },
];

test('compile produces a per-principal bundle with one rule per tool', () => {
  const b = compileConnectionProfile('conn-x', TOOLS);
  assert.equal(b.principal, 'conn-x');
  assert.equal(Object.keys(b.tools).length, 5);
  assert.equal(b.tools.update_amount.maxAmount, 50000);
});

test('exposed = Read/Write-approval/Write-bounded only (Off + Blocked hidden)', () => {
  const b = compileConnectionProfile('conn-x', TOOLS);
  const ex = exposedTools(b).sort();
  assert.deepEqual(ex, ['create_page', 'read_account', 'update_amount']);
  assert.ok(!ex.includes('mass_update'));
  assert.ok(!ex.includes('delete_record'));
});

test('evaluateRule honours every mode', () => {
  assert.equal(evaluateRule({ mode: 'Read', write: false }).effect, 'allow');
  assert.equal(evaluateRule({ mode: 'Off', write: true }).effect, 'deny');
  assert.equal(evaluateRule({ mode: 'Blocked', write: true }).effect, 'deny');
  assert.equal(evaluateRule({ mode: 'Write-approval', write: true }).effect, 'requires_approval');
});

test('Write-bounded allows within the bound and denies outside it', () => {
  const rule = { mode: 'Write-bounded' as const, write: true, maxAmount: 50000 };
  assert.equal(evaluateRule(rule, { amount: 40000 }).effect, 'allow');
  assert.equal(evaluateRule(rule, { amount: 60000 }).effect, 'deny');
  assert.equal(evaluateRule(rule, {}).effect, 'deny'); // missing numeric arg
});

test('decide enforces a per-agent grant (restrict-only)', () => {
  const b = compileConnectionProfile('conn-x', TOOLS, [{ agent: 'agent-a', tools: ['read_account'] }]);
  // agent-a may read but not the bounded write (not in its grant)
  assert.equal(decide(b, 'read_account', {}, 'agent-a').effect, 'allow');
  assert.equal(decide(b, 'update_amount', { amount: 1 }, 'agent-a').effect, 'deny');
  // an agent with no grant entry is unrestricted by the grant layer (profile still applies)
  assert.equal(decide(b, 'update_amount', { amount: 1 }, 'agent-b').effect, 'allow');
});

test('decide denies an unknown / unexposed tool', () => {
  const b = compileConnectionProfile('conn-x', TOOLS);
  assert.equal(decide(b, 'no_such_tool').effect, 'deny');
});

test('the generic Rego artifact is shipped (static policy logic)', () => {
  assert.match(GENERIC_REGO, /package connections\.authz/);
  assert.match(GENERIC_REGO, /requires_approval/);
});

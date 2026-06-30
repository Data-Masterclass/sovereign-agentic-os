/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreview,
  rememberPolicy,
  matchStandingPolicy,
  revokeStandingPolicy,
  _clearStandingPolicies,
  resolveAutonomous,
  effectivePreset,
  setDomainDefaultPreset,
  setAgentPreset,
  setAgentToolPreset,
  _clearPresets,
} from './governance.ts';
import { evaluateRule } from './capability-compiler.ts';

// -------- Mode A: full preview + approve & remember -> standing policy --------

test('buildPreview yields a before/after diff, who and reason', () => {
  const p = buildPreview({
    action: 'update_opportunity_amount',
    args: { id: 'OPP-1', amount: 42000 },
    before: { amount: 38000 },
    who: 'alice',
    reason: 'renewal uplift',
  });
  assert.equal(p.who, 'alice');
  assert.equal(p.reason, 'renewal uplift');
  // id is an identifier, excluded from the diff; amount is the change
  assert.deepEqual(p.diff, [{ field: 'amount', before: 38000, after: 42000 }]);
});

test('approve & remember creates a bounded standing policy that auto-allows identical calls', () => {
  _clearStandingPolicies();
  assert.equal(matchStandingPolicy('conn-sf', 'update_amount', { amount: 1000 }), null);
  const pol = rememberPolicy({ principal: 'conn-sf', tool: 'update_amount', maxAmount: 50000, createdBy: 'alice' });
  // within bound -> matched (no prompt); over bound -> still prompts
  assert.ok(matchStandingPolicy('conn-sf', 'update_amount', { amount: 40000 }));
  assert.equal(matchStandingPolicy('conn-sf', 'update_amount', { amount: 60000 }), null);
  assert.ok(revokeStandingPolicy(pol.id));
  assert.equal(matchStandingPolicy('conn-sf', 'update_amount', { amount: 40000 }), null);
});

// -------- Mode B: autonomous safety presets (profile is the ceiling) --------

const readDecision = evaluateRule({ mode: 'Read', write: false });
const boundedOk = evaluateRule({ mode: 'Write-bounded', write: true, maxAmount: 50000 }, { amount: 1000 });
const approvalDecision = evaluateRule({ mode: 'Write-approval', write: true });
const blockedDecision = evaluateRule({ mode: 'Blocked', write: true });

test('read-only blocks all writes, allows reads', () => {
  assert.equal(resolveAutonomous('read-only', readDecision, 'Read', false).effect, 'allow');
  assert.equal(resolveAutonomous('read-only', boundedOk, 'Write-bounded', true).effect, 'block');
});

test('read-propose drafts writes for a human', () => {
  assert.equal(resolveAutonomous('read-propose', boundedOk, 'Write-bounded', true).effect, 'propose');
});

test('read-bounded auto-runs bounded writes, queues approval-writes', () => {
  assert.equal(resolveAutonomous('read-bounded', boundedOk, 'Write-bounded', true).effect, 'allow');
  const r = resolveAutonomous('read-bounded', approvalDecision, 'Write-approval', true);
  assert.equal(r.effect, 'block');
  assert.ok(r.queue, 'approval-write must be queued for async review');
});

test('full-in-scope runs profile-allowed writes; out-of-policy (Blocked) is blocked+queued', () => {
  assert.equal(resolveAutonomous('full-in-scope', boundedOk, 'Write-bounded', true).effect, 'allow');
  const r = resolveAutonomous('full-in-scope', blockedDecision, 'Blocked', true);
  assert.equal(r.effect, 'block');
  assert.ok(r.queue);
});

test('effectivePreset: per-tool > per-agent > domain default > read-only', () => {
  _clearPresets();
  assert.equal(effectivePreset('ag', 'sales', 'conn', 'tool'), 'read-only');
  setDomainDefaultPreset('sales', 'read-propose');
  assert.equal(effectivePreset('ag', 'sales', 'conn', 'tool'), 'read-propose');
  setAgentPreset('ag', 'read-bounded');
  assert.equal(effectivePreset('ag', 'sales', 'conn', 'tool'), 'read-bounded');
  setAgentToolPreset('ag', 'conn', 'tool', 'full-in-scope');
  assert.equal(effectivePreset('ag', 'sales', 'conn', 'tool'), 'full-in-scope');
});

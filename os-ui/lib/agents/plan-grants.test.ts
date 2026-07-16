/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planGrantId,
  manualScopeOfPlanId,
  manualLabel,
  manualAvailableScope,
  MANUAL_SCOPES,
} from './plan-grants.ts';
import { parseSystem, serializeSystem } from './system-schema.ts';
import { setArtifactGrantLevel, removeArtifactGrant } from './simple-edit.ts';
import { toolsForGrant } from './capability-tools.ts';

/**
 * Operating-Manual PLAN grants: the id encoding round-trips, granting one records the
 * grant in `grants.plan` AND provisions the governed `get_operating_manual` read tool,
 * and the schema stays byte-stable when no plan grant exists.
 */

test('plan-grant id encodes + round-trips each Operating-Manual scope', () => {
  for (const scope of MANUAL_SCOPES) {
    assert.equal(manualScopeOfPlanId(planGrantId(scope)), scope);
  }
  assert.equal(planGrantId('my'), 'manual:my');
  assert.equal(planGrantId('domain'), 'manual:domain');
  assert.equal(planGrantId('company'), 'manual:company');
  // Non-manual ids parse to null (fail-closed).
  assert.equal(manualScopeOfPlanId('wf_123'), null);
  assert.equal(manualScopeOfPlanId('manual:bogus'), null);
});

test('labels + available-scope buckets use the My/Domain/Company vocabulary', () => {
  assert.equal(manualLabel('my'), 'My Operating Manual');
  assert.equal(manualLabel('domain'), 'Domain Operating Manual');
  assert.equal(manualLabel('company'), 'Company Operating Manual');
  assert.equal(manualAvailableScope('my'), 'personal');
  assert.equal(manualAvailableScope('domain'), 'domain');
  assert.equal(manualAvailableScope('company'), 'marketplace');
});

test('a plan grant provisions the governed manual read tool', () => {
  // The exact tool the runtime uses to load a granted manual, DLS-checked in-store.
  assert.deepEqual(toolsForGrant('plan', 'Read'), ['get_operating_manual']);
  // Read-only: a "write" plan grant provisions nothing extra.
  assert.deepEqual(toolsForGrant('plan', 'Write-bounded'), ['get_operating_manual']);
});

const BASE = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: analyst
grants: { tools: [] }
agents:
  - { id: analyst, role: Analyzes, agent_md: "# analyst", memory_md: "" }
`;

test('granting the Domain manual records grants.plan + injects the read tool; removal reverts', () => {
  const sys = parseSystem(BASE);
  const withManual = setArtifactGrantLevel(sys, 'plan', planGrantId('domain'), 'read-only');
  // Recorded in the plan grant list at Read.
  assert.deepEqual(withManual.grants.plan, [{ id: 'manual:domain', capability: 'Read' }]);
  // The governed read tool is injected so the agent can actually LOAD the manual.
  assert.ok(withManual.grants.tools.includes('get_operating_manual'));
  // It serializes (present) and re-parses to the same grant.
  const round = parseSystem(serializeSystem(withManual));
  assert.deepEqual(round.grants.plan, [{ id: 'manual:domain', capability: 'Read' }]);
  // Removing the last plan grant drops it.
  const without = removeArtifactGrant(withManual, 'plan', planGrantId('domain'));
  assert.deepEqual(without.grants.plan, []);
});

test('a system with no plan grant stays byte-stable (no grants.plan key emitted)', () => {
  const sys = parseSystem(BASE);
  assert.deepEqual(sys.grants.plan, []);
  const yaml = serializeSystem(sys);
  assert.ok(!yaml.includes('plan'), 'empty plan grant must not appear in system.yaml');
});

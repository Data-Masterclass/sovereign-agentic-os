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
  pillarPlanId,
  pillarIdOfPlanId,
  bigBetPlanId,
  bigBetIdOfPlanId,
  planTargetOf,
} from './plan-grants.ts';
import { parseSystem, serializeSystem } from './system-schema.ts';
import { setArtifactGrantLevel, removeArtifactGrant } from './simple-edit.ts';
import { toolsForGrant, planToolsForId } from './capability-tools.ts';

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
  assert.equal(manualLabel('my'), 'My Operating Model');
  assert.equal(manualLabel('domain'), 'Domain Operating Model');
  assert.equal(manualLabel('company'), 'Company Operating Model');
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

test('pillar + big-bet plan-grant ids encode + round-trip; classify to the right target', () => {
  assert.equal(pillarPlanId('p_42'), 'pillar:p_42');
  assert.equal(pillarIdOfPlanId(pillarPlanId('p_42')), 'p_42');
  assert.equal(bigBetPlanId('bet_7'), 'bigbet:bet_7');
  assert.equal(bigBetIdOfPlanId(bigBetPlanId('bet_7')), 'bet_7');

  // Cross-parse is fail-closed (a pillar id is not a bet id, and vice-versa).
  assert.equal(bigBetIdOfPlanId('pillar:p_42'), null);
  assert.equal(pillarIdOfPlanId('bigbet:bet_7'), null);
  assert.equal(pillarIdOfPlanId('pillar:'), null); // empty id → null
  assert.equal(bigBetIdOfPlanId('bigbet:'), null);

  // planTargetOf classifies every plan id and null for anything else.
  assert.equal(planTargetOf('manual:domain'), 'manual');
  assert.equal(planTargetOf('pillar:p_42'), 'pillar');
  assert.equal(planTargetOf('bigbet:bet_7'), 'bigbet');
  assert.equal(planTargetOf('wf_123'), null);
});

test('planToolsForId provisions the read tool matching the plan target (read-only)', () => {
  assert.deepEqual(planToolsForId('manual:my', 'Read'), ['get_operating_manual']);
  assert.deepEqual(planToolsForId('pillar:p_1', 'Read'), ['get_pillar', 'list_pillars']);
  assert.deepEqual(planToolsForId('bigbet:bet_1', 'Read'), ['get_big_bet', 'list_big_bets']);
  // A "write" plan grant is still read-only — the tools don't change, nothing widens.
  assert.deepEqual(planToolsForId('pillar:p_1', 'Write-bounded'), ['get_pillar', 'list_pillars']);
  // Off/Blocked + unrecognised ids provision nothing (fail-closed).
  assert.deepEqual(planToolsForId('pillar:p_1', 'Off'), []);
  assert.deepEqual(planToolsForId('nonsense', 'Read'), []);
});

test('granting a pillar records grants.plan + provisions get_pillar; a bet provisions get_big_bet', () => {
  const sys = parseSystem(BASE);

  const withPillar = setArtifactGrantLevel(sys, 'plan', pillarPlanId('p_9'), 'read-only');
  assert.deepEqual(withPillar.grants.plan, [{ id: 'pillar:p_9', capability: 'Read' }]);
  assert.ok(withPillar.grants.tools.includes('get_pillar'));
  assert.ok(withPillar.grants.tools.includes('list_pillars'));
  // The manual tool is NOT provisioned by a pillar grant (per-target, not per-kind).
  assert.ok(!withPillar.grants.tools.includes('get_operating_manual'));

  const withBet = setArtifactGrantLevel(withPillar, 'plan', bigBetPlanId('bet_3'), 'read-only');
  assert.deepEqual(withBet.grants.plan, [
    { id: 'pillar:p_9', capability: 'Read' },
    { id: 'bigbet:bet_3', capability: 'Read' },
  ]);
  assert.ok(withBet.grants.tools.includes('get_big_bet'));
  assert.ok(withBet.grants.tools.includes('list_big_bets'));

  // Round-trips through serialize/parse, and removing reverts the grant list.
  const round = parseSystem(serializeSystem(withBet));
  assert.deepEqual(round.grants.plan, withBet.grants.plan);
  const without = removeArtifactGrant(withBet, 'plan', bigBetPlanId('bet_3'));
  assert.deepEqual(without.grants.plan, [{ id: 'pillar:p_9', capability: 'Read' }]);
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

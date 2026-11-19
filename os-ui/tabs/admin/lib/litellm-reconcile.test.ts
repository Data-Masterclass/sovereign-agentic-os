/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the one-way reconcile decision table.
 *
 * USER STORY: As a platform admin I need certainty that reconcile creates what
 *             is missing, leaves my hand-made gateway objects alone, and never
 *             overwrites a budget I set in LiteLLM.
 *
 * ARCHITECTURE:
 *   Drives the PURE `buildPlan` with hand-built mirrors, so the whole decision
 *   table is covered without a network. The write shell (`applyReconcile`) is
 *   one loop over `adminPost` and holds no decisions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, teamAlias, agentKeyAlias } from './litellm-reconcile.ts';
import type { GatewayMirror } from './gateway-mirror.ts';

function mirror(over: Partial<GatewayMirror> = {}): GatewayMirror {
  return {
    models: [], teams: [], keys: [], guardrails: [],
    spend: { byDomain: {}, byUser: {}, byAgent: {}, byTab: {} },
    unmanaged: [], fetchedAt: 1, degraded: false,
    ...over,
  };
}
const team = (alias: string, maxBudget: number | null = null) => ({ teamId: `t-${alias}`, alias, maxBudget, spend: 0, models: [] });

test('RECONCILE: a domain with no team is a create', () => {
  const p = buildPlan(mirror(), { domains: ['finance'], agents: [] });
  assert.equal(p.creates.length, 1);
  assert.equal(p.creates[0].endpoint, '/team/new');
  assert.equal(p.creates[0].payload.team_alias, teamAlias('finance'));
});

test('RECONCILE: a domain that already has a team is left alone', () => {
  const p = buildPlan(mirror({ teams: [team('finance')] }), { domains: ['finance'], agents: [] });
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.updates, []);
});

test('RECONCILE: team matching ignores case', () => {
  const p = buildPlan(mirror({ teams: [team('Finance')] }), { domains: ['finance'], agents: [] });
  assert.deepEqual(p.creates, []);
});

test('RECONCILE: a budget set in LiteLLM is NEVER overwritten', () => {
  const p = buildPlan(mirror({ teams: [team('finance', 250)] }), { domains: ['finance'], agents: [] });
  const ops = [...p.creates, ...p.updates];
  assert.deepEqual(ops, [], 'reconcile must not touch a cap the gateway admin set');
  // And no create op ever carries a budget of its own.
  const fresh = buildPlan(mirror(), { domains: ['new-domain'], agents: [] });
  assert.equal('max_budget' in fresh.creates[0].payload, false);
});

test('RECONCILE: an agent system with no key is NOT given one here — it is listed as needing a Build', () => {
  const p = buildPlan(mirror(), { domains: [], agents: ['triage'] });
  assert.deepEqual(p.creates, [], 'reconcile must not create a key: it could set no budget and keep no value');
  assert.deepEqual(p.updates, []);
  assert.deepEqual(p.needsBuild, ['triage']);
  assert.equal(agentKeyAlias('triage'), 'os-triage', 'one key scheme: the alias Build uses');
});

test('RECONCILE: a system whose Build key exists needs nothing', () => {
  const keys = [{ alias: 'os-triage', owner: 'agent' as const, blocked: false, spend: 0 }];
  const p = buildPlan(mirror({ keys }), { domains: [], agents: ['triage'] });
  assert.deepEqual([p.creates, p.updates, p.needsBuild], [[], [], []]);
});

test('RECONCILE: the old unbudgeted `agent-<id>` key does not count as the system\'s key and is never touched here', () => {
  const keys = [{ alias: 'agent-triage', owner: 'agent' as const, blocked: false, spend: 0 }];
  const p = buildPlan(mirror({ keys }), { domains: [], agents: ['triage'] });
  assert.deepEqual(p.needsBuild, ['triage']);
  assert.deepEqual([...p.creates, ...p.updates].filter((o) => o.kind === 'key'), [], 'no key op of any kind — the sweep removes the old key');
});

test('RECONCILE: drift is reported and is never an applicable op', () => {
  const p = buildPlan(mirror({ unmanaged: [{ kind: 'key', id: 'hand-made' }] }), { domains: [], agents: [] });
  assert.equal(p.drift.length, 1);
  assert.equal(p.drift[0].endpoint, '(not applied)');
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.updates, []);
});

test('RECONCILE: a degraded mirror marks the plan untrustworthy', () => {
  assert.equal(buildPlan(mirror({ degraded: true }), { domains: [], agents: [] }).degraded, true);
});

test('RECONCILE: an empty LiteLLM gets its teams back; the systems are listed for a Build', () => {
  const p = buildPlan(mirror(), { domains: ['finance', 'ops'], agents: ['triage', 'summariser'] });
  assert.equal(p.creates.filter((o) => o.kind === 'team').length, 2);
  assert.equal(p.creates.filter((o) => o.kind === 'key').length, 0, 'keys come from Build, never from reconcile');
  assert.deepEqual(p.needsBuild, ['triage', 'summariser']);
});

test('RECONCILE: every op explains itself to the admin', () => {
  const p = buildPlan(mirror({ unmanaged: [{ kind: 'team', id: 'x' }] }), { domains: ['finance'], agents: ['triage'] });
  for (const op of [...p.creates, ...p.updates, ...p.drift]) {
    assert.ok(op.reason.length > 20, `op ${op.kind}/${op.id} has no usable reason`);
  }
});

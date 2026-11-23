/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A system key allows exactly the role names its agents run on — role NAMES, so a remap needs no rebuild
 * USER STORY: As the owner I want an agent system's key to allow only the models its agents use (strong, standard or
 *             both), and as a platform admin I remap a role in Platform → Models with no key rebuild.
 * ARCHITECTURE:
 *   - `keyWanted` (the one comparison the Build and the key reconcile share) lists `agentRoles` (each agent's ONE
 *     model, `agent-model.ts`) plus the gateway's fallback targets. Twins: a legacy system (no field) is strong only;
 *     Auto follows its stored decision; a fallback target stays allowed; the key is the same whichever catalog model
 *     a role maps to (the mapping is not an input); a key that lacks a needed role is drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyWanted, keyDrift, agentRoles, type LiteLlmKeyState } from '@tabs/agents/lib/build/live';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';

const YAML = (a: string, b: string) => `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: one
grants:
  tools: [search_knowledge]
agents:
  - { id: one, role: w, agent_md: "# One", memory_md: ""${a} }
  - { id: two, role: w, agent_md: "# Two", memory_md: ""${b} }
edges:
  - { from: one, to: two, type: handoff }
`;
const want = (yaml: string, fallbacks?: { default: string[]; fallbacks: Record<string, string[]> }) => {
  const system = parseSystem(yaml);
  return keyWanted({ fallbacks } as Parameters<typeof keyWanted>[0])({ system, ir: compile(system), systemId: 'sys_a' });
};

test('LEGACY (no model field): the key allows only sovereign-strong', async () => {
  assert.deepEqual((await want(YAML('', ''))).models, ['sovereign-strong']);
});

test('all Standard: only sovereign-worker; mixed: both', async () => {
  assert.deepEqual((await want(YAML(', model: standard', ', model: standard'))).models, ['sovereign-worker']);
  assert.deepEqual([...(await want(YAML(', model: strong', ', model: standard'))).models].sort(), ['sovereign-strong', 'sovereign-worker']);
});

test('Auto follows the stored Build decision; an undecided Auto agent is Strong', async () => {
  assert.deepEqual((await want(YAML(', model: auto, model_resolved: standard, model_reason: r', ', model: standard'))).models, ['sovereign-worker']);
  assert.deepEqual((await want(YAML(', model: auto', ', model: standard'))).models.sort(), ['sovereign-strong', 'sovereign-worker']);
});

test('the embedding role is never on a system key (a run calls no embedding with it)', async () => {
  assert.ok(!(await want(YAML('', ''))).models.includes('sovereign-embedding'));
});

test('TWIN: a gateway fallback target of a used role stays allowed (the existing rule)', async () => {
  const w = await want(YAML(', model: standard', ', model: standard'), { default: [], fallbacks: { 'sovereign-worker': ['sovereign-strong'] } });
  assert.deepEqual([...w.models].sort(), ['sovereign-strong', 'sovereign-worker']);
});

test('agentRoles counts every agent, sorted and distinct', () => {
  assert.deepEqual(agentRoles(parseSystem(YAML(', model: standard', ''))), ['sovereign-strong', 'sovereign-worker']);
});

test('NEGATIVE TWIN: a key without a needed role is drift; one with exactly the roles is not', async () => {
  const w = await want(YAML(', model: strong', ', model: standard'));
  const have: LiteLlmKeyState = { tokenId: 't', models: ['sovereign-strong'], maxBudget: w.maxBudget, budgetDuration: w.budgetDuration, rpmLimit: w.rpmLimit, tpmLimit: w.tpmLimit, maxParallelRequests: w.maxParallelRequests, allowedTools: [...w.allowedTools] };
  assert.ok(keyDrift(have, w).some((c) => c.startsWith('models ')));
  assert.equal(keyDrift({ ...have, models: [...w.models] }, w).length, 0);
});

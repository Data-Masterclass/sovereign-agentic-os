/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { modelReferences } from '@tabs/admin/lib/model-references';
import { _reset as resetSettings, updateSettings } from '@tabs/admin/lib/settings';
import { _reset as resetModels, setAssistantModel } from '@tabs/admin/lib/models';

// The agent-system store pins its state to this shared global (see
// lib/agents/store.ts) — tests seed it directly, exactly as a hydrated store would.
const AGENTS_KEY = Symbol.for('soa.agents.store');
type Rec = { id: string; name: string; yaml: string; archived?: boolean };
function seedAgentStore(recs: Rec[]): void {
  (globalThis as unknown as Record<symbol, unknown>)[AGENTS_KEY] = {
    store: new Map(recs.map((r) => [r.id, r])),
    seeded: true,
    hydration: Promise.resolve(),
  };
}

beforeEach(() => {
  resetSettings();
  resetModels();
  (globalThis as unknown as { __osRoleReport?: unknown }).__osRoleReport = undefined;
  seedAgentStore([]);
});

test('an unreferenced alias has no usages', () => {
  assert.deepEqual(modelReferences('my-cloud-llm'), []);
});

const mapRoles = (m: Record<string, string> | null) => { (globalThis as unknown as { __osRoleReport?: unknown }).__osRoleReport = { last: { mapping: m } }; };

test('a catalog model a role is mapped to surfaces as "<Role> role (Platform → Models)"', () => {
  mapRoles({ 'sovereign-strong': 'my-cloud-llm', 'sovereign-worker': 'other', 'sovereign-embedding': 'emb' });
  assert.deepEqual(modelReferences('my-cloud-llm'), [{ kind: 'role', label: 'Strong role (Platform → Models)' }]);
});

test('NEGATIVE TWIN: with no mapping yet, or for a model no role uses, there is no role usage', () => {
  mapRoles(null);
  assert.deepEqual(modelReferences('my-cloud-llm'), []);
  mapRoles({ 'sovereign-strong': 'a', 'sovereign-worker': 'b', 'sovereign-embedding': 'c' });
  assert.deepEqual(modelReferences('my-cloud-llm'), []);
});

test('an explicit assistant pin surfaces', () => {
  setAssistantModel('my-cloud-llm');
  assert.deepEqual(modelReferences('my-cloud-llm'), [{ kind: 'assistant', label: 'Assistant model pin' }]);
});

test('agent per-node pins surface with the system name and node ids', () => {
  seedAgentStore([
    {
      id: 'sys1',
      name: 'Order triage',
      yaml: 'system:\n  name: Order triage\nagents:\n  - id: planner\n    model: my-cloud-llm\n  - id: writer\n    model: my-cloud-llm\n  - id: other\n',
    },
    { id: 'sys2', name: 'Untouched', yaml: 'agents:\n  - id: a\n    model: sovereign-strong\n' },
  ]);
  const refs = modelReferences('my-cloud-llm');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'agent');
  assert.ok(refs[0].label.includes('Order triage'));
  assert.ok(refs[0].label.includes('planner'));
  assert.ok(refs[0].label.includes('writer'));
});

test('archived systems and unparseable yaml are skipped, never fabricated or fatal', () => {
  seedAgentStore([
    { id: 'sys1', name: 'Archived', archived: true, yaml: 'agents:\n  - id: a\n    model: my-cloud-llm\n' },
    { id: 'sys2', name: 'Broken', yaml: 'my-cloud-llm: [unclosed' },
  ]);
  assert.deepEqual(modelReferences('my-cloud-llm'), []);
});

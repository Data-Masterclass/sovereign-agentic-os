/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { modelReferences } from './model-references.ts';
import { _reset as resetSettings, updateSettings } from './settings.ts';
import { _reset as resetModels, registerModel, setAssistantModel } from './models.ts';

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

const ENDPOINT = { baseUrl: 'https://llm.example/v1', modelName: 'up', keyRef: { name: 'model-x', key: 'api_key' }, fingerprint: 'sha256:ab' };

beforeEach(() => {
  resetSettings();
  resetModels();
  seedAgentStore([]);
});

test('an unreferenced alias has no usages', () => {
  assert.deepEqual(modelReferences('my-cloud-llm'), []);
});

test('an explicit role pin surfaces as "<Role> role pin"', () => {
  updateSettings({ modelRoles: { standard: 'my-cloud-llm' } });
  const refs = modelReferences('my-cloud-llm');
  assert.deepEqual(refs, [{ kind: 'role', label: 'Standard role pin' }]);
});

test('a role RESOLVING to the alias by default also counts (removal breaks it too)', () => {
  // sovereign-default is the env baseline for both standard and tools.
  const labels = modelReferences('sovereign-default').map((r) => r.label);
  assert.ok(labels.includes('Standard role default'));
  assert.ok(labels.includes('Tools role default'));
  // Follow-Standard assistant is NOT double-reported as an assistant pin.
  assert.ok(!modelReferences('sovereign-default').some((r) => r.kind === 'assistant'));
});

test('an explicit assistant pin surfaces', () => {
  registerModel({ id: 'my-cloud-llm', label: 'My cloud LLM', task: 'chat', providerType: 'openai-compatible', endpoint: ENDPOINT, addedBy: 'sara' });
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
    { id: 'sys2', name: 'Untouched', yaml: 'agents:\n  - id: a\n    model: sovereign-reasoning\n' },
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

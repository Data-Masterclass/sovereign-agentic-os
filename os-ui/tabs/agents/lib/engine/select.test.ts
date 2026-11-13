/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Tests for engine selection (platform flag × per-system runtime key)
 * USER STORY: As a maintainer I want proof that the platform flag decides by default, that a
 *             system can pin the walker, and that a hermes system never selects the new engine.
 * ARCHITECTURE:
 *   - Pure unit tests over `selectEngine` / `explainEngine`; parses real system.yaml text so
 *     the `runtime: walker` schema addition is exercised end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { selectEngine, explainEngine } from '@tabs/agents/lib/engine/select';

const BASE = `version: '1'
system: { name: T, domain: sales, visibility: Personal }
entrypoint: a
agents:
  - { id: a, role: agent, agent_md: '', memory_md: '' }
`;

test('default runtime follows the platform flag in both directions', () => {
  const sys = parseSystem(BASE);
  assert.equal(sys.runtime, 'langgraph');
  assert.equal(selectEngine({ agentsEngine: 'walker' }, sys), 'walker');
  assert.equal(selectEngine({ agentsEngine: 'langgraph' }, sys), 'langgraph');
});

test('runtime: walker pins the legacy walker even when the platform default is langgraph', () => {
  const sys = parseSystem(`${BASE}runtime: walker\n`);
  assert.equal(sys.runtime, 'walker');
  assert.equal(selectEngine({ agentsEngine: 'langgraph' }, sys), 'walker');
  assert.equal(explainEngine({ agentsEngine: 'langgraph' }, sys).reason, 'system.yaml pins runtime: walker');
});

test('runtime: walker round-trips through the serializer (an explicit opt-out survives a save)', () => {
  const sys = parseSystem(`${BASE}runtime: walker\n`);
  const again = parseSystem(serializeSystem(sys));
  assert.equal(again.runtime, 'walker');
  // The default stays omitted so every existing file is byte-stable.
  assert.ok(!serializeSystem(parseSystem(BASE)).includes('runtime:'));
});

test('a hermes system never selects the in-process langgraph engine', () => {
  const sys = parseSystem(`${BASE}runtime: hermes\n`);
  assert.equal(selectEngine({ agentsEngine: 'langgraph' }, sys), 'walker');
  assert.match(explainEngine({ agentsEngine: 'langgraph' }, sys).reason, /hermes/);
});

test('an unknown runtime value is still rejected by the schema', () => {
  assert.throws(() => parseSystem(`${BASE}runtime: python\n`), /runtime 'python' is invalid/);
});

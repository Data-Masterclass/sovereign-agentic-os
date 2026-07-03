/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import { SOFTWARE_TEAM_YAML } from './software-team.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// os-ui/lib/agents → repo-root/seed/software-team/system.yaml
const SEED_YAML = resolve(HERE, '../../../seed/software-team/system.yaml');

test('the canonical team yaml compiles into the 6-agent graph', () => {
  const sys = parseSystem(SOFTWARE_TEAM_YAML);
  assert.equal(sys.runtime, 'langgraph');
  assert.equal(sys.entrypoint, 'orchestrator');
  assert.deepEqual(
    sys.agents.map((a) => a.id),
    ['orchestrator', 'planner', 'builder', 'tester', 'deployer', 'communication'],
  );
  // Model routing: builder on the coding/execution tier, the rest on reasoning.
  const model = Object.fromEntries(sys.agents.map((a) => [a.id, a.model]));
  assert.equal(model.builder, 'sovereign-default');
  for (const id of ['orchestrator', 'planner', 'tester', 'deployer', 'communication']) {
    assert.equal(model[id], 'sovereign-reasoning', `${id} pins the reasoning tier`);
  }
  // Compiles clean (narrow-only holds, edges declared, entrypoint declared).
  const ir = compile(sys);
  assert.equal(ir.nodes.length, 6);
  assert.ok(ir.nodes.find((n) => n.id === 'orchestrator')?.supervisor, 'orchestrator is the supervisor');
});

test('the seed system.yaml mirror is byte-identical to the canonical constant (no drift)', () => {
  const onDisk = readFileSync(SEED_YAML, 'utf8');
  assert.equal(onDisk, SOFTWARE_TEAM_YAML, 'seed/software-team/system.yaml must match SOFTWARE_TEAM_YAML');
});

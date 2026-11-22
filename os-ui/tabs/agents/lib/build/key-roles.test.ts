/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Every agent key allows the three role names, so a remap needs no key rebuild.
 * USER STORY: As a platform admin I remap sovereign-strong in Platform → Models and every agent system's
 *             next call uses the new model — their keys already allow the role, whatever it points at.
 * ARCHITECTURE:
 *   - `keyWanted` (the one comparison the Build and the key reconcile share) always includes
 *     sovereign-strong, -worker and -embedding, plus what the definition pins. Negative twins: a pinned
 *     model is still allowed; the keys are the same whichever catalog model a role maps to (the mapping is
 *     not an input); a key that lacks a role is reported as drift by `keyDrift`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyWanted, keyDrift, type LiteLlmKeyState } from '@tabs/agents/lib/build/live';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { ROLE_NAMES } from '@core/models/role-mapping';

const YAML = (model: string) => `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: ${model} }
`;
const ctx = (model: string) => { const system = parseSystem(YAML(model)); return { system, ir: compile(system), systemId: 'sys_a' }; };
const deps = (runModels?: () => string[]) => ({ runModels, fallbacks: undefined } as Parameters<typeof keyWanted>[0]);

test('a system key always allows the three role names', async () => {
  const want = await keyWanted(deps(() => []))(ctx('auto'));
  for (const r of ROLE_NAMES) assert.ok(want.models.includes(r), `${r} in ${want.models.join(',')}`);
});

test('the default routing and the run roles call only role names', async () => {
  const want = await keyWanted(deps(() => ['sovereign-strong', 'sovereign-worker']))(ctx('auto'));
  assert.deepEqual(want.models.filter((m) => !(ROLE_NAMES as readonly string[]).includes(m)), []);
});

test('NEGATIVE TWIN: an agent pinned to a catalog model keeps that model allowed too', async () => {
  const want = await keyWanted(deps(() => []))(ctx('kimi-k3.1-pro'));
  assert.ok(want.models.includes('kimi-k3.1-pro'));
  for (const r of ROLE_NAMES) assert.ok(want.models.includes(r));
});

test('NEGATIVE TWIN: a key without a role is drift (so a remap would 403 on it)', async () => {
  const want = await keyWanted(deps(() => []))(ctx('auto'));
  const have: LiteLlmKeyState = { tokenId: 't', models: want.models.filter((m) => m !== 'sovereign-strong'), maxBudget: want.maxBudget, budgetDuration: want.budgetDuration, rpmLimit: want.rpmLimit, tpmLimit: want.tpmLimit, maxParallelRequests: want.maxParallelRequests, allowedTools: [...want.allowedTools] };
  assert.ok(keyDrift(have, want).length > 0);
  assert.equal(keyDrift({ ...have, models: [...want.models] }, want).length, 0);
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    Every OS model call resolves to ONE of the three role names — nothing else.
 * USER STORY: As the owner I want the OS to call only sovereign-strong, sovereign-worker and
 *             sovereign-embedding, so a remap in Platform → Models changes what answers without a
 *             restart, a key rebuild or a code change.
 * ARCHITECTURE:
 *   - `roleModel(role)` maps the OS's own roles onto the three names: standard and tools → worker;
 *     reasoning and coder → strong; embeddings → embedding. The old admin override
 *     (`settings.modelRoles`) and the old LITELLM_*_MODEL env defaults are NOT consulted any more.
 *   - Each behaviour has a negative twin that fails if the old path comes back.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { roleModel, roleModels, type ModelRole } from '@core/models/roles';
import { ROLE_NAMES } from '@core/models/role-mapping';
import { updateSettings, _reset } from '@tabs/admin/lib/settings';

beforeEach(() => { _reset(); });

const EXPECT: Record<ModelRole, string> = {
  standard: 'sovereign-worker',
  tools: 'sovereign-worker',
  reasoning: 'sovereign-strong',
  coder: 'sovereign-strong',
  embeddings: 'sovereign-embedding',
};

test('each OS role resolves to exactly its role name', () => {
  for (const [role, want] of Object.entries(EXPECT)) assert.equal(roleModel(role as ModelRole), want, role);
});

test('roleModels() holds only role names', () => {
  for (const [role, name] of Object.entries(roleModels())) assert.ok((ROLE_NAMES as readonly string[]).includes(name), `${role} → ${name}`);
});

test('NEGATIVE TWIN: the old admin override no longer decides — a stored value for a role changes nothing', () => {
  updateSettings({ modelRoles: { reasoning: 'some-real-model', standard: 'sovereign-mock', tools: 'x', embeddings: 'y' } });
  for (const [role, want] of Object.entries(EXPECT)) assert.equal(roleModel(role as ModelRole), want, `${role} ignores the override`);
});

test('NEGATIVE TWIN: the old env defaults no longer decide', () => {
  const saved = { ...process.env };
  process.env.LITELLM_REASONING_MODEL = 'env-model'; process.env.LITELLM_EXEC_MODEL = 'env-model'; process.env.LITELLM_TOOLS_MODEL = 'env-model'; process.env.LITELLM_CODER_MODEL = 'env-model'; process.env.KNOWLEDGE_EMBED_MODEL = 'env-model';
  try {
    for (const [role, want] of Object.entries(EXPECT)) assert.equal(roleModel(role as ModelRole), want, role);
  } finally { process.env = saved; }
});

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The run worker re-reads the admin settings, so model-role pins reach agent runs.
 * USER STORY: As a platform admin I point Standard (or tools) at a newly registered provider and
 *             the next agent run uses it — reproduced end to end before this: the worker kept the
 *             values it booted with and every run stayed on `sovereign-default`.
 * ARCHITECTURE: the settings mirror is replaced with an in-memory doc (`mock.module`); the process
 *               role is the real `core/kernel/process-role` flag; the clock is `Date.now`.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let stored: { settings: Record<string, unknown> } | null = null;
let reads = 0;
mock.module('@core/infra/os-mirror', {
  namedExports: {
    osMirror: () => ({
      getDoc: async () => { reads += 1; return stored; },
      writeThrough: () => {},
      __reset: () => {},
    }),
  },
});

const { ensureHydrated, getSettings, _reset, SETTINGS_REFRESH_MIN_MS } = await import('@tabs/admin/lib/settings');
const { markRunWorkerProcess, __clearRunWorkerProcess } = await import('@core/kernel/process-role');
const { roleModel, ensureModelRolesFresh } = await import('@core/models/roles');

const roles = (standard: string) => ({ settings: { modelRoles: { reasoning: '', standard, tools: '', embeddings: '' } } });

test('the web app reads the settings doc once (it is the writer)', async () => {
  _reset(); __clearRunWorkerProcess(); reads = 0;
  stored = roles('mistral-small');
  await ensureHydrated();
  stored = roles('something-else');
  await ensureHydrated();
  assert.equal(reads, 1);
  assert.equal(getSettings().modelRoles.standard, 'mistral-small');
});

test('the run worker picks up a role an admin saved after it booted', async () => {
  _reset(); markRunWorkerProcess(); reads = 0;
  let now = 1_000_000;
  const clock = mock.method(Date, 'now', () => now);
  try {
    stored = null; // booted before the admin saved anything
    await ensureModelRolesFresh();
    assert.equal(roleModel('standard'), 'sovereign-default');
    stored = roles('mistral-small');
    now += SETTINGS_REFRESH_MIN_MS - 1;
    await ensureModelRolesFresh();
    assert.equal(roleModel('standard'), 'sovereign-default', 'no re-read inside the refresh window');
    now += 2;
    await ensureModelRolesFresh();
    assert.equal(roleModel('standard'), 'mistral-small');
  } finally {
    clock.mock.restore(); __clearRunWorkerProcess();
  }
});

test('an unreadable doc on a re-read keeps the held values (never resets to defaults)', async () => {
  _reset(); markRunWorkerProcess();
  let now = 2_000_000;
  const clock = mock.method(Date, 'now', () => now);
  try {
    stored = roles('mistral-small');
    await ensureModelRolesFresh();
    stored = null;
    now += SETTINGS_REFRESH_MIN_MS + 1;
    await ensureModelRolesFresh();
    assert.equal(roleModel('standard'), 'mistral-small');
  } finally {
    clock.mock.restore(); __clearRunWorkerProcess();
  }
});

test('every model-call entry point makes the roles current before resolving a model', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
  const exec = src('tabs/agents/lib/build/run-jobs-server.ts');
  assert.ok(exec.indexOf('await ensureModelRolesFresh()') > 0 && exec.indexOf('await ensureModelRolesFresh()') < exec.indexOf('prepareRun(user, view, job.systemId)'));
  assert.match(src('core/runtime/complete.ts'), /await ensureAssistantModelFresh\(\);\s*\n\s*const model = /);
  assert.match(src('core/runtime/runtime.ts'), /if \(!injected\) await ensureAssistantModelFresh\(\);/);
  assert.match(src('core/runtime/agent-loop.ts'), /if \(!injected\) await ensureAssistantModelFresh\(\);/);
});

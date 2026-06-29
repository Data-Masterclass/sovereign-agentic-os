/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { runAdapter, type BuildAdapter, type BuildContext } from './adapter.ts';

function ctx(): BuildContext {
  const system = parseSystem(`
entrypoint: a
grants: { tools: [retrieve] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  return { system, ir: compile(system) };
}

test('apply→verify both ok yields a ✓ row', async () => {
  const a: BuildAdapter = {
    tool: 'fake',
    apply: async () => ({ ok: true, detail: 'applied' }),
    verify: async () => ({ ok: true, detail: 'verified' }),
  };
  const row = await runAdapter(a, ctx());
  assert.equal(row.status, 'ok');
  assert.equal(row.applied, true);
  assert.equal(row.verified, true);
});

test('a stubbed-✓ apply but FAILING verify surfaces ✗ (Build never lies)', async () => {
  const a: BuildAdapter = {
    tool: 'fake',
    apply: async () => ({ ok: true, detail: 'pretended to apply' }),
    verify: async () => ({ ok: false, detail: 'probe found nothing', error: 'no graph reloaded' }),
  };
  const row = await runAdapter(a, ctx());
  assert.equal(row.status, 'fail');
  assert.equal(row.applied, true);
  assert.equal(row.verified, false);
  assert.match(row.error ?? '', /no graph reloaded/);
});

test('an apply failure short-circuits verify and surfaces ✗', async () => {
  let verifyCalled = false;
  const a: BuildAdapter = {
    tool: 'fake',
    apply: async () => ({ ok: false, detail: 'could not apply', error: 'boom' }),
    verify: async () => {
      verifyCalled = true;
      return { ok: true, detail: 'should not run' };
    },
  };
  const row = await runAdapter(a, ctx());
  assert.equal(row.status, 'fail');
  assert.equal(verifyCalled, false);
  assert.match(row.error ?? '', /boom/);
});

test('a thrown adapter is caught and reported as ✗', async () => {
  const a: BuildAdapter = {
    tool: 'fake',
    apply: async () => {
      throw new Error('kaboom');
    },
    verify: async () => ({ ok: true, detail: '' }),
  };
  const row = await runAdapter(a, ctx());
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /kaboom/);
});

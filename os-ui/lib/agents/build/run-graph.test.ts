/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Gateway, type GwTrace } from '../gateway.ts';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { runGraph } from './run-graph.ts';

function spyGateway(allow: (tool: string) => boolean) {
  const traces: GwTrace[] = [];
  const gw: Gateway = {
    authorize: (_p, tool) =>
      allow(tool) ? { effect: 'allow', reason: 'granted' } : { effect: 'deny', reason: 'no' },
    trace: (e) => {
      traces.push(e);
    },
  };
  return { gw, traces };
}

const SYS = `
entrypoint: supervisor
grants: { tools: [retrieve, write_file] }
agents:
  - { id: supervisor, role: router, agent_md: "", memory_md: "", members: [worker], tools: [retrieve] }
  - { id: worker, role: specialist, agent_md: "", memory_md: "", tools: [write_file] }
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

test('a disabled agent does not run its tools on a Run', async () => {
  // Finding #2 — toggled-off agents must be skipped on a Run, not executed.
  const ir = compile(parseSystem(SYS));
  const { gw } = spyGateway(() => true);
  const res = await runGraph(ir, { gateway: gw, disabled: ['worker'] });

  assert.ok(!res.path.includes('worker'), 'disabled worker is not in the run path');
  assert.ok(!res.steps.some((s) => s.node === 'worker'), "disabled worker's tools never run");
  // The enabled supervisor still runs and the run reaches END.
  assert.ok(res.path.includes('supervisor'));
  assert.equal(res.reachedEnd, true);
});

const SYS_TWO_MEMBERS = `
entrypoint: supervisor
grants: { tools: [retrieve, write_file] }
agents:
  - { id: supervisor, role: router, agent_md: "", memory_md: "", members: [a, b], tools: [retrieve] }
  - { id: a, role: one, agent_md: "", memory_md: "", tools: [retrieve] }
  - { id: b, role: two, agent_md: "", memory_md: "", tools: [write_file] }
edges:
  - { from: supervisor, to: a, type: supervise }
  - { from: supervisor, to: b, type: supervise }
`;

test('disabling one member still runs its enabled sibling', async () => {
  // Finding #2 — a per-agent toggle is surgical: disabling 'a' leaves 'b' running.
  const ir = compile(parseSystem(SYS_TWO_MEMBERS));
  const { gw } = spyGateway(() => true);
  const res = await runGraph(ir, { gateway: gw, disabled: ['a'] });
  assert.ok(!res.path.includes('a'), 'disabled member is skipped');
  assert.ok(res.path.includes('b'), 'the enabled sibling still runs');
  assert.equal(res.reachedEnd, true);
});

test('with no disabled list every agent still runs (no regression)', async () => {
  const ir = compile(parseSystem(SYS));
  const { gw } = spyGateway(() => true);
  const res = await runGraph(ir, { gateway: gw });
  assert.ok(res.path.includes('worker'));
  assert.ok(res.steps.some((s) => s.node === 'worker'));
});

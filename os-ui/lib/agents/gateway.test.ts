/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invokeTool, type Gateway, type GwTrace } from './gateway.ts';
import { parseSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import { runGraph } from './build/run-graph.ts';

function spyGateway(allow: (tool: string) => boolean) {
  const traces: GwTrace[] = [];
  const gw: Gateway = {
    authorize: (_p, tool) =>
      allow(tool)
        ? { effect: 'allow', reason: 'granted' }
        : { effect: 'deny', reason: `${tool} not granted` },
    trace: (e) => {
      traces.push(e);
    },
  };
  return { gw, traces };
}

test('invokeTool runs the side effect only when authorized, and always traces', async () => {
  const { gw, traces } = spyGateway((t) => t === 'retrieve');
  let ran = 0;
  const ok = await invokeTool(gw, 'agent-a', 'retrieve', {}, () => {
    ran++;
    return 'passages';
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'passages');
  assert.equal(ran, 1);

  const denied = await invokeTool(gw, 'agent-a', 'connection_crm_write', {}, () => {
    ran++;
    return 'wrote';
  });
  assert.equal(denied.ok, false);
  assert.equal(ran, 1); // side effect did NOT run
  assert.equal(traces.length, 2); // BOTH calls traced
  assert.deepEqual(
    traces.map((t) => t.decision),
    ['allow', 'deny'],
  );
});

const SYS = `
entrypoint: supervisor
grants: { tools: [retrieve, connection_crm_write] }
agents:
  - id: supervisor
    role: router
    agent_md: ""
    memory_md: ""
    members: [worker]
    tools: [retrieve]
  - id: worker
    role: specialist
    agent_md: ""
    memory_md: ""
    tools: [connection_crm_write]
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

test('GATEWAY INVARIANT: a graph run forces EVERY tool call through the gateway', async () => {
  const ir = compile(parseSystem(SYS));
  // worker's write is denied; supervisor's retrieve is allowed.
  const { gw, traces } = spyGateway((t) => t === 'retrieve');
  const sideEffects: string[] = [];
  const res = await runGraph(ir, {
    gateway: gw,
    toolRunner: (_p, tool) => {
      sideEffects.push(tool);
      return `${tool}-result`;
    },
  });

  // The run reaches END across supervisor → worker.
  assert.equal(res.reachedEnd, true);
  // Two tool-call ATTEMPTS were made (retrieve, connection_crm_write)...
  assert.equal(res.steps.length, 2);
  // ...and EACH produced exactly one trace — no tool can bypass the chokepoint.
  assert.equal(traces.length, res.steps.length);
  // The denied write never executed its side effect; only the allowed tool did.
  assert.deepEqual(sideEffects, ['retrieve']);
  const denied = res.steps.find((s) => s.tool === 'connection_crm_write')!;
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.ran, false);
});

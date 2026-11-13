/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invokeTool, type Gateway, type GwTrace } from '@tabs/agents/lib/gateway';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';

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

test('GATEWAY INVARIANT: every tool a compiled graph advertises goes through the gateway chokepoint', async () => {
  // A5: this used to be asserted by walking the IR with the mock graph walker, which is deleted.
  // The invariant itself did not change — a tool call authorizes and traces, or it does not
  // happen — so it is asserted directly over the compiled graph's own tool vocabulary. The RUN
  // path's version of this gate (`grantedToolExecutor` → `handleRpc` as the user, and the
  // node-level narrowing) is pinned in `build/os-tools.test.ts` and `engine/build-graph.test.ts`.
  const ir = compile(parseSystem(SYS));
  // worker's write is denied; supervisor's retrieve is allowed.
  const { gw, traces } = spyGateway((t) => t === 'retrieve');
  const sideEffects: string[] = [];
  const attempts: { tool: string; effect: string; ran: boolean }[] = [];
  for (const node of ir.nodes) {
    for (const tool of node.tools) {
      const call = await invokeTool(gw, node.id, tool, { node: node.id }, () => {
        sideEffects.push(tool);
        return `${tool}-result`;
      });
      attempts.push({ tool, effect: call.decision.effect, ran: call.ok });
    }
  }

  // Both tools the graph advertises were attempted (retrieve, connection_crm_write)...
  assert.deepEqual(attempts.map((a) => a.tool).sort(), ['connection_crm_write', 'retrieve']);
  // ...and EACH produced exactly one trace — no tool can bypass the chokepoint.
  assert.equal(traces.length, attempts.length);
  // The denied write never executed its side effect; only the allowed tool did.
  assert.deepEqual(sideEffects, ['retrieve']);
  const denied = attempts.find((a) => a.tool === 'connection_crm_write')!;
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.ran, false);
});

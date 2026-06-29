/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { trace as gvTrace } from '@/lib/agent-governed';
import { enqueue } from '@/lib/approvals';
import { parseSystem, type System } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { type Effect, type Gateway } from '../gateway.ts';
import { runGraph, type RunResult } from './run-graph.ts';
import { newMockBackends, makeMockAdapters, registerGrants, gatewayFor } from './mocks.ts';
import { orchestrateBuild, type BuildReport } from './orchestrate.ts';

/**
 * Server boundary for Build/Run (kind-only, mocked). It runs the SAME pure
 * orchestrator + gateway the unit tests use, but bridges every governed tool
 * call into the REAL Langfuse trace ring buffer (so Monitoring shows the system's
 * activity) and enqueues any `requires_approval` write into the Governance queue.
 */

/** A Gateway that wraps an inner one and also lands traces in the real ring buffer. */
function bridged(inner: Gateway, principal: string): Gateway {
  return {
    authorize: inner.authorize,
    trace: async (e) => {
      await inner.trace(e);
      void gvTrace({
        principal,
        tool: e.tool,
        input: e.input,
        output: e.output,
        decision: e.decision as Effect,
      });
    },
  };
}

export async function buildSystem(systemId: string, yaml: string): Promise<BuildReport> {
  const backends = newMockBackends();
  const adapters = makeMockAdapters(backends);
  const report = await orchestrateBuild({ yaml, systemId, adapters, probe: 'Build verification' });
  // Mirror the test-invocation traces into the real Langfuse ring buffer.
  for (const t of backends.langfuse.traces) {
    void gvTrace({ principal: systemId, tool: t.tool, input: t.input, output: t.output, decision: t.decision as Effect });
  }
  return report;
}

export type RunReport = {
  ok: boolean;
  path: string[];
  steps: RunResult['steps'];
  traces: number;
  held: number;
};

export async function runSystem(
  systemId: string,
  yaml: string,
  opts: { prompt: string; requestedBy: string; disabledAgents?: string[] },
): Promise<RunReport> {
  const sys = parseSystem(yaml);
  const ir = compile(sys);
  const backends = newMockBackends();
  registerGrants(backends, sys);
  const gw = bridged(gatewayFor(backends), systemId);

  const res = await runGraph(ir, { gateway: gw, probe: opts.prompt, disabled: opts.disabledAgents });

  // Any write the run could not perform without approval is held in Governance.
  let held = 0;
  for (const step of res.steps) {
    if (step.effect === 'requires_approval') {
      held++;
      enqueue({
        kind: 'connection_write',
        title: `Approval needed: ${step.tool}`,
        detail: `System '${systemId}' agent '${step.node}' attempted a write-approval tool during a run.`,
        agent: `${systemId}:${step.node}`,
        domain: sys.system.domain,
        requestedBy: opts.requestedBy,
        tool: step.tool,
      });
    }
  }
  return { ok: res.reachedEnd, path: res.path, steps: res.steps, traces: res.traces, held };
}

export type ConnectionProbe = { effect: Effect; reason: string; held: boolean };

/**
 * Probe a connection tool against the system's grants (Task 6): granted Read →
 * allow, non-granted → deny, Write-approval → requires_approval (held in the
 * Governance queue). `asAgentTools` further narrows per-agent (never broadens).
 */
export async function probeConnection(
  system: System,
  systemId: string,
  input: { connectionId: string; write?: boolean; requestedBy: string },
): Promise<ConnectionProbe> {
  const backends = newMockBackends();
  registerGrants(backends, system);
  const gw = gatewayFor(backends);
  const tool = `connection_${input.connectionId}`;
  const decision = await gw.authorize('probe', tool, { write: input.write });
  void gvTrace({
    principal: `${systemId}:probe`,
    tool,
    input: { connectionId: input.connectionId, write: input.write },
    output: { effect: decision.effect, reason: decision.reason },
    decision: decision.effect,
  });
  let held = false;
  if (decision.effect === 'requires_approval') {
    held = true;
    enqueue({
      kind: 'connection_write',
      title: `Approval needed: ${tool}`,
      detail: `Write to connection '${input.connectionId}' requested via system '${systemId}'.`,
      agent: systemId,
      domain: system.system.domain,
      requestedBy: input.requestedBy,
      tool,
    });
  }
  return { effect: decision.effect, reason: decision.reason, held };
}

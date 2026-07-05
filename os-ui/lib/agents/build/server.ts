/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { trace as gvTrace } from '@/lib/agent-governed';
import { enqueue } from '@/lib/approvals';
import { parseSystem, type System } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { type Effect, type Gateway } from '../gateway.ts';
import { runGraph, type RunResult } from './run-graph.ts';
import { newMockBackends, makeMockAdapters, registerGrants, gatewayFor } from './mocks.ts';
import { makeLiveAdapters } from './live.ts';
import { makeRealClients, runtimeReachable, traceStoreReachable } from './live-clients.ts';
import { reloadRequest, runRequest } from './runtime-contract.ts';
import { orchestrateBuild, type BuildReport } from './orchestrate.ts';

/**
 * Server boundary for Build/Run (Approach A — live execution). When the shared
 * agent-runtime is reachable (a cluster is up), Build runs the 5 LIVE adapters
 * against the real services and Run is a synchronous os-ui → runtime `/run`; the
 * runtime funnels every tool call back through the os-ui governed-tool endpoint
 * (OPA authorize + Langfuse trace there). When the runtime is unreachable (a
 * laptop with no cluster), it falls back to the in-process teaching MOCK so the
 * golden-path flow still works — honestly labelled `mode: 'offline-mock'`.
 *
 * Auth discipline preserved: a write held by OPA (`requires_approval`) is never
 * executed and is enqueued into the Governance queue with the run's human-in-the-
 * loop attribution.
 */

export type BuildMode = 'live' | 'offline-mock';

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

export async function buildSystem(systemId: string, yaml: string): Promise<BuildReport & { mode: BuildMode }> {
  if (await runtimeReachable()) {
    const report = await orchestrateBuild({
      yaml,
      systemId,
      adapters: makeLiveAdapters(makeRealClients()),
      probe: 'Build verification',
    });
    // The live langgraph verify already traced every tool call via the governed
    // endpoint, so there is nothing to mirror here.
    return { ...report, mode: 'live' };
  }
  // Offline teaching fallback: the in-process mock build.
  const backends = newMockBackends();
  const report = await orchestrateBuild({
    yaml,
    systemId,
    adapters: makeMockAdapters(backends),
    probe: 'Build verification',
  });
  for (const t of backends.langfuse.traces) {
    void gvTrace({ principal: systemId, tool: t.tool, input: t.input, output: t.output, decision: t.decision as Effect });
  }
  return { ...report, mode: 'offline-mock' };
}

export type RunReport = {
  ok: boolean;
  path: string[];
  steps: RunResult['steps'];
  traces: number;
  held: number;
  mode: BuildMode;
  /** The run's final output/summary — surfaced inline so the user sees what the
   *  agent did without depending on the (currently down) Langfuse trace store. */
  output: string;
  /** True when the durable Langfuse trace store accepted the run's traces; when
   *  false the UI shows the in-run steps instead of a dead deep-link. */
  traceStoreAvailable: boolean;
  /** Optional deep-link to the full Langfuse trace, present only when the trace
   *  store is reachable AND a console URL is configured. */
  traceUrl?: string;
};

export async function runSystem(
  systemId: string,
  yaml: string,
  opts: { prompt: string; requestedBy: string; disabledAgents?: string[] },
): Promise<RunReport> {
  const sys = parseSystem(yaml);
  const ir = compile(sys);

  if (await runtimeReachable()) {
    const clients = makeRealClients();
    // Ensure the runtime has the current graph, then run it synchronously. Each
    // tool call funnels back through the governed-tool endpoint (authorize+trace).
    await clients.runtime.reload(reloadRequest(systemId, ir));
    const res = await clients.runtime.run(
      runRequest(systemId, opts.prompt, { disabledAgents: opts.disabledAgents ?? [] }),
    );
    const steps = res.steps;
    const held = enqueueHolds(systemId, sys, steps, opts.requestedBy);
    const output = res.output || `Reached ${res.path.join(' → ')} → END (${steps.length} governed tool call(s)).`;
    const traceStoreAvailable = await traceStoreReachable();
    const traceUrl =
      traceStoreAvailable && config.langfuseConsoleUrl
        ? `${config.langfuseConsoleUrl}/traces`
        : undefined;
    return {
      ok: res.reachedEnd,
      path: res.path,
      steps,
      traces: res.traces,
      held,
      mode: 'live',
      output,
      traceStoreAvailable,
      traceUrl,
    };
  }

  // Offline teaching fallback: run the graph in-process through the mock gateway.
  const backends = newMockBackends();
  registerGrants(backends, sys);
  const gw = bridged(gatewayFor(backends), systemId);
  const res = await runGraph(ir, { gateway: gw, probe: opts.prompt, disabled: opts.disabledAgents });
  const held = enqueueHolds(systemId, sys, res.steps, opts.requestedBy);
  return {
    ok: res.reachedEnd,
    path: res.path,
    steps: res.steps,
    traces: res.traces,
    held,
    mode: 'offline-mock',
    output: res.output,
    // Offline teaching path has no durable trace store; the in-run steps ARE the record.
    traceStoreAvailable: false,
  };
}

/**
 * Enqueue a Governance approval for every write the run could not perform without
 * approval. The runtime/gateway already declined to execute the held write; this
 * records the human-in-the-loop request with the run's attribution.
 */
function enqueueHolds(
  systemId: string,
  sys: System,
  steps: RunResult['steps'],
  requestedBy: string,
): number {
  let held = 0;
  for (const step of steps) {
    if (step.effect !== 'requires_approval') continue;
    held++;
    enqueue({
      kind: 'connection_write',
      title: `Approval needed: ${step.tool}`,
      detail: `System '${systemId}' agent '${step.node}' attempted a write-approval tool during a run.`,
      agent: `${systemId}:${step.node}`,
      domain: sys.system.domain,
      requestedBy,
      tool: step.tool,
    });
  }
  return held;
}

export type ConnectionProbe = { effect: Effect; reason: string; held: boolean };

/**
 * Probe a connection tool against the system's grants (Task 6): granted Read →
 * allow, non-granted → deny, Write-approval → requires_approval (held in the
 * Governance queue). Authorizes BEFORE any side effect and honors the read/write
 * flag.
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

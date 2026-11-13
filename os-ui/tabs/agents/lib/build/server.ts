/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { trace as gvTrace } from '@core/infra/agent-governed';
import { enqueue } from '@core/policy/approvals';
import { type System } from '@tabs/agents/lib/system-schema';
import { type Effect, type Gateway } from '@tabs/agents/lib/gateway';
import { newMockBackends, makeMockAdapters, registerGrants, gatewayFor } from '@tabs/agents/lib/build/mocks';
import { makeLiveAdapters } from '@tabs/agents/lib/build/live';
import { makeRealClients, gatewayAdminReachable } from '@tabs/agents/lib/build/live-clients';
import { orchestrateBuild, type BuildReport } from '@tabs/agents/lib/build/orchestrate';

/**
 * Server boundary for BUILD. When the model gateway's admin API is reachable (a cluster is
 * up), Build runs the LIVE adapters against the real services — OPA grants, the scoped
 * LiteLLM key, the compiled StateGraph, Langfuse. On a laptop with no cluster it falls back
 * to the in-process teaching MOCK so the golden-path flow still works — honestly labelled
 * `mode: 'offline-mock'`.
 *
 * A5: RUN no longer lives here. There was a second run path on this boundary (os-ui →
 * Python `agent-runtime` `/run`, with a mock graph walk as its offline twin); both are
 * deleted. Every run of every system now goes through the queue and the one engine
 * (`run-jobs-server.ts` → `engine/build-graph.ts`), so this file builds and probes only.
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
  if (await gatewayAdminReachable()) {
    const report = await orchestrateBuild({
      yaml,
      systemId,
      adapters: makeLiveAdapters(makeRealClients()),
      probe: 'Build verification',
    });
    // The live adapters write their own governance traces as they go, so there is
    // nothing to mirror here.
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

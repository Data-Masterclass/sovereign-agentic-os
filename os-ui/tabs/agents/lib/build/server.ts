/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { offlineMockAllowed, refuseOfflineMock } from '@core/kernel/offline-mock';
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

/**
 * Build as every door does: first decide and store the Auto agents' models (`model-choice-server.ts`), then build the
 * stored definition; the report leads with the `models` row when there was a choice to make. The MCP
 * `build_agent_system` uses this (the Agents tab route does the same steps around the owner-governed yaml).
 */
export async function buildSystemWithModelChoice(input: { systemId: string; user: CurrentUser; yaml: string }): Promise<BuildReport & { mode: BuildMode }> {
  // Lazy: the gateway caller chain imports the MCP registry, which imports this module.
  const { resolveAutoModelsForBuild } = await import('@tabs/agents/lib/build/model-choice-server');
  const models = await resolveAutoModelsForBuild(input);
  const built = await buildSystem(input.systemId, models.yaml);
  return models.row ? { ...built, rows: [models.row, ...built.rows] } : built;
}

export async function buildSystem(systemId: string, yaml: string, opts: { rotateKey?: boolean } = {}): Promise<BuildReport & { mode: BuildMode }> {
  if (await gatewayAdminReachable()) {
    const report = await orchestrateBuild({
      yaml,
      systemId,
      adapters: makeLiveAdapters(makeRealClients()),
      probe: 'Build verification',
      rotateKey: opts.rotateKey,
    });
    // The live adapters write their own governance traces as they go, so there is
    // nothing to mirror here.
    return { ...report, mode: 'live' };
  }
  // THE HONESTY GATE (2026-11-18). The mock build writes no OPA grants, mints no scoped
  // LiteLLM key, reloads no graph and lands no Langfuse trace \u2014 it reports \u2713 for work that did
  // not happen, and the Build panel's green rows are what a user trusts before pressing Run. On a
  // real deployment refuse instead; the teaching flow keeps the in-process build.
  if (!offlineMockAllowed()) {
    refuseOfflineMock(
      `Cannot build agent system ${systemId}: the model gateway's admin API is unreachable, so the ` +
        'grants, the scoped key and the compiled graph cannot be verified. Nothing was built.',
    );
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

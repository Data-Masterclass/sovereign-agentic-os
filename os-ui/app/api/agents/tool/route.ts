/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import {
  authorize,
  trace,
  metricsTool,
  retrieveTool,
  SALES,
  type DlsPrincipal,
  type ToolName,
} from '@core/infra/agent-governed';
import { grantsForDurable } from '@core/infra/app-registry';
import { realOpa } from '@tabs/agents/lib/build/live-clients';
import { principalFor, type GovernedToolResponse } from '@tabs/agents/lib/build/runtime-contract';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { ensureHydrated, systemForScheduler } from '@tabs/agents/lib/store';
import { registerDurableAgentGrantResolver } from '@tabs/agents/lib/build/grant-rehydrate';

export const dynamic = 'force-dynamic';

// Self-healing grants (durability across pod restarts): teach the app-registry how
// to read an agent system's granted tools back from the DURABLE agent-system store
// so a `os-<id>` principal's grants rehydrate on the first tool call after a
// restart wiped the in-memory registry — no rebuild needed. Fail-closed: an unknown
// system resolves to no grants, so authorization falls through to OPA/deny.
registerDurableAgentGrantResolver();

/**
 * The GOVERNED TOOL endpoint (Approach A). The shared agent-runtime holds NO
 * OPA/Langfuse access and NO resource creds — it funnels EVERY tool call back
 * here. This route is the single chokepoint that makes the gateway invariant real
 * (creds + Cilium egress, not honor-system): it authorizes the system principal
 * `os-<systemId>` against OPA, runs the side effect ONLY when allowed (a held
 * write is never executed), and ALWAYS traces the attempt into Langfuse — exactly
 * the `lib/agent-governed` spine every other governed caller uses.
 *
 * Authenticated by the shared runtime bearer (server-only), NOT a user session:
 * the caller is the runtime Pod, reachable only over the Cilium-allowed path.
 */

/**
 * Run the granted tool's side effect. Real where the spine provides one
 * (`metrics`/`retrieve`, which degrade offline); a governed stub otherwise — the
 * point of the endpoint is authorize + trace, not the tool's payload.
 */
async function runSideEffect(
  tool: string,
  args: Record<string, unknown>,
  dls: DlsPrincipal,
): Promise<unknown> {
  if (tool === 'metrics') {
    return metricsTool(typeof args.measure === 'string' ? args.measure : SALES.revenueMeasure);
  }
  if (tool === 'retrieve') {
    // DLS is scoped to the SYSTEM's own domain (default-deny outside it), so a
    // system can never retrieve another domain's private knowledge.
    return retrieveTool(typeof args.prompt === 'string' ? args.prompt : '', dls);
  }
  return { ok: true, tool, note: 'governed tool invoked' };
}

export async function POST(req: Request) {
  if (!runtimeTokenOk(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    systemId?: string;
    node?: string;
    tool?: string;
    args?: Record<string, unknown>;
    write?: boolean;
  };
  const { systemId, node, tool } = body;
  if (!systemId || !tool) {
    return NextResponse.json({ error: 'systemId and tool are required' }, { status: 400 });
  }
  const args = body.args ?? {};
  const write = body.write === true;
  const principal = principalFor(systemId);

  // Ensure the durable store is hydrated so the grant resolver can read this
  // system's persisted record even on the first request after a cold start.
  await ensureHydrated();

  // Authorize BEFORE any side effect (honoring read/write); never run-then-check.
  // Ask OPA first to enforce OS tool policies, including requires_approval.
  // If OPA denies because a restart wiped its in-memory grants, restore grants
  // from the DURABLE agent-system record and retry ONCE. Fail-closed if the
  // durable record doesn't list this tool or re-provisioning fails (OPA
  // unreachable). authorizeAppTool() itself is left unchanged: software-app
  // MCP depends on its current grant-first behavior.
  let authz = await authorize(principal, tool as ToolName);
  if (authz.effect === 'deny') {
    const durableTools = await grantsForDurable(principal);
    if (durableTools.includes(tool)) {
      try {
        await realOpa().putGrants(principal, durableTools);
        authz = await authorize(principal, tool as ToolName);
      } catch {
        /* OPA unreachable — keep the original deny, fail-closed */
      }
    }
  }

  if (authz.effect !== 'allow') {
    // Denied or held: the side effect is NOT executed; the attempt is still traced.
    await trace({
      principal: `${principal}:${node ?? 'run'}`,
      tool,
      input: { ...args, write },
      output: { blocked: authz.reason, effect: authz.effect },
      decision: authz.effect,
    });
    const res: GovernedToolResponse = { effect: authz.effect, reason: authz.reason, output: { held: authz.effect === 'requires_approval' } };
    return NextResponse.json(res);
  }

  // The DLS identity for retrieval is the SYSTEM's own domain (participant-level
  // reach: Shared-in-domain + Marketplace), never a client-supplied one.
  const sysMeta = systemForScheduler(systemId);
  const dls: DlsPrincipal = { id: principal, domains: sysMeta ? [sysMeta.domain] : [], role: 'creator' };
  const output = await runSideEffect(tool, args, dls);
  await trace({
    principal: `${principal}:${node ?? 'run'}`,
    tool,
    input: { ...args, write },
    output,
    decision: 'allow',
  });
  const res: GovernedToolResponse = { effect: 'allow', reason: authz.reason, output };
  return NextResponse.json(res);
}

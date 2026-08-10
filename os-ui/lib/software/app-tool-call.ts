/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { executeAppTool, type RecordActor } from './app-records.ts';
import { authorizeAppTool, authorizeConnectionCall, trace } from '@/lib/infra/agent-governed';
import { enqueue } from '@/lib/governance/approvals';
import type { App } from './apps.ts';

/**
 * The GOVERNED-SPINE composition behind an app-MCP tool call, lifted verbatim from
 * the apps/[id]/tool route so the route keeps only parse + auth + response shaping.
 *
 * It runs the SAME governed spine as every other agent tool: authorize (OPA-style,
 * resolved from the app's compiled capability profile, falling back to its dynamic
 * app-registry grant) → hold writes for human approval → deny → execute (the shared
 * live-or-seed executor) → Langfuse trace. Behaviour is identical to the inline copy;
 * the HTTP status codes are returned as `status` for the route to apply verbatim
 * (202 approval-hold, 403 deny, 200 allow).
 */
export type AppToolCallResult = {
  /** The HTTP status the route should return (200 / 202 / 403). */
  status: 200 | 202 | 403;
  /** The JSON body the route should return. */
  body: Record<string, unknown>;
};

export async function callAppTool(
  app: App,
  tool: string,
  args: Record<string, unknown> | undefined,
  requestedBy: string,
  /** The raw parsed request body — used verbatim as the deny-trace input (as before). */
  rawBody: unknown,
  /** The caller identity, so RECORD tools resolve to the OS-side app-records store,
   *  scoped to what this caller may see (My + Domain). Omitted for non-record callers. */
  actor?: RecordActor,
): Promise<AppToolCallResult> {
  const principal = app.mcpPrincipal;

  // Honor the auto-MCP capability profile (reads-on / writes-off preset compiled
  // to OPA). A read tool is allowed; a write tool is HELD for human approval and
  // queued in the Governance inbox — never silently executed. Falls back to the
  // app-registry grant when no compiled profile is present (older in-memory app).
  const profile = authorizeConnectionCall(principal, tool, args);
  const authz =
    profile.reason.startsWith('unknown connection principal')
      ? await authorizeAppTool(principal, tool)
      : { effect: profile.effect, policy: 'app-grant' as const, reason: profile.reason };

  if (authz.effect === 'requires_approval') {
    enqueue({
      kind: 'connection_write',
      title: `Approval needed: ${tool}`,
      detail: `Write to app MCP '${app.name}' (${principal}) requested via the app tool surface.`,
      agent: principal,
      domain: app.domain,
      requestedBy,
      tool,
      payload: { appId: app.id, args: args ?? {} },
    });
    const tr = await trace({ principal, tool, input: args ?? {}, output: { held: true, reason: authz.reason }, decision: 'requires_approval' });
    return {
      status: 202,
      body: { tool, principal, decision: 'requires_approval', policy: authz.policy, reason: authz.reason, held: true, traceId: tr.id },
    };
  }
  if (authz.effect !== 'allow') {
    const tr = await trace({ principal, tool, input: rawBody, output: { denied: authz.reason }, decision: 'deny' });
    return {
      status: 403,
      body: { tool, principal, decision: authz.effect, policy: authz.policy, reason: authz.reason, traceId: tr.id },
    };
  }

  // Execute: proxy to the REAL app when its runner pod is running, else demo seed —
  // the SHARED executor the app's own records routes also use (one store, two doors).
  const execArgs = (args ?? {}) as Record<string, unknown>;
  const result = await executeAppTool(app, tool, execArgs, actor);

  const tr = await trace({ principal, tool, input: args ?? {}, output: result, decision: 'allow', costUsd: 0.0004 });
  return {
    status: 200,
    body: { tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, result },
  };
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { executeAppTool, type RecordActor } from '@tabs/software/lib/app-records';
import { authorizeAppTool, authorizeConnectionCall, exposedConnectionTools, trace } from '@core/infra/agent-governed';
import { enqueue } from '@core/policy/approvals';
import type { App } from '@tabs/software/lib/apps';
import { authorizeDeclaredAction, parseAppActions, type AdoptionPort } from '@tabs/software/lib/app-actions';
import { getSnapshot, hydrateSnapshot } from '@tabs/software/lib/snapshot';

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
  /**
   * REVIEW H-2: the DOMAIN-ADOPTION layer, injected by the route (a tab may not import another
   * tab, and the adoption store lives in the connections tab). Present ⇒ the app's DECLARED
   * actions are gated on the full four-layer intersection; absent ⇒ no declared action is
   * callable at all. There is no "assume adopted" path: the gate is fail-closed either way.
   */
  adoption?: AdoptionPort,
): Promise<AppToolCallResult> {
  const principal = app.mcpPrincipal;

  // ---- DECLARED ACTIONS (review H-2) -----------------------------------------------------
  // An app's `actions.yml` surface is governed by capability ∩ declaration ∩ ADOPTION ∩ grant,
  // checked BEFORE the legacy auto-MCP authorization so a declared action can never be allowed
  // by the older, adoption-free path. A tool that is NOT declared falls through to exactly the
  // behaviour it had before this landed — the gate arrives with the surface it governs, so no
  // app in production loses access overnight.
  await hydrateSnapshot(app.id);
  const declared = parseAppActions(getSnapshot(app.id) ?? []).actions;
  if (declared.some((a) => a.name === tool)) {
    const decision = authorizeDeclaredAction(
      tool,
      {
        declared,
        capability: exposedConnectionTools(principal),
        granted: (app.mcpTools ?? []).map((t) => t.name),
        domain: app.domain,
        appExposureId: principal,
      },
      adoption ?? {
        adopted: () => false, // fail-closed: no port wired ⇒ nothing is adopted
      },
    );
    if (decision.effect === 'deny') {
      const tr = await trace({ principal, tool, input: rawBody, output: { denied: decision.reason, layer: decision.layer }, decision: 'deny' });
      return {
        status: 403,
        body: { tool, principal, decision: 'deny', policy: 'app-grant', layer: decision.layer, reason: decision.reason, traceId: tr.id },
      };
    }
    if (decision.effect === 'requires_approval') {
      enqueue({
        kind: 'connection_write',
        title: `Approval needed: ${tool}`,
        detail: `Declared app action '${tool}' on '${app.name}' (${principal}) writes, and the run is under the reads-on/writes-off preset.`,
        agent: principal,
        domain: app.domain,
        requestedBy,
        tool,
        payload: { appId: app.id, args: args ?? {} },
      });
      const tr = await trace({ principal, tool, input: args ?? {}, output: { held: true, reason: decision.reason }, decision: 'requires_approval' });
      return {
        status: 202,
        body: { tool, principal, decision: 'requires_approval', policy: 'app-grant', reason: decision.reason, held: true, traceId: tr.id },
      };
    }
  }

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

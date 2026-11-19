/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getAppForUser } from '@tabs/software/lib/apps';
import { callAppTool } from '@tabs/software/lib/app-tool-call';
import { recordActor } from '@tabs/software/lib/app-records';
import { allActiveAdoptions, adoptionCovers } from '@tabs/connections/lib/action-adoptions';
import { APP_AGENT_TOOLS, callAppAgentTool, type AppAgentRpc } from '@tabs/software/lib/app-agent-door';
import { handleRpc } from '@core/mcp/server';

export const dynamic = 'force-dynamic';

/**
 * Call an app's AUTO-GENERATED MCP tool as an agent would (Software golden path
 * §4 + Agent golden path). The call funnels through the SAME governed spine as
 * every other agent tool: OPA-style authorize (here resolved from the app's
 * dynamic grant in the app-registry) + Langfuse trace. A tool the app's MCP did
 * not expose is denied — honest default-deny.
 *
 * EXECUTION honesty: when the app's runner pod is actually RUNNING, the call is
 * proxied to the app's real in-cluster Service per its committed OpenAPI and
 * labelled `source:'live-app'`. Otherwise deterministic seed data keeps the flow
 * demonstrable — ALWAYS labelled `source:'demo-seed'` with a visible note. That
 * live-or-seed execution is the SHARED executor (`executeAppTool`, app-records.ts)
 * the app's own by-slug records routes also call — one store, two doors.
 */

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;

  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let app;
  try {
    app = await getAppForUser(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 404 });
  }

  const tool = String(body?.tool ?? '');

  // An agents grant compiles `run_agent_system` + `list_agent_systems` into the app's profile.
  // They are the OS's own agent tools, not the app's, so they are answered by the OS's MCP tools
  // of the same name, as the signed-in user, limited to the agent systems this app was granted.
  if (APP_AGENT_TOOLS.has(tool)) {
    const rpc: AppAgentRpc = async (name, args) => {
      const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      if (!res || 'error' in res && res.error) return { ok: false, message: (res as { error?: { message?: string } })?.error?.message ?? 'no response' };
      const result = (res as { result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: { error?: { code?: string; reason?: string } } } }).result ?? {};
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
      if (result.isError) {
        const err = result.structuredContent?.error;
        return { ok: false, message: err?.reason ?? text, code: err?.code };
      }
      return { ok: true, text };
    };
    const { status, body: payload } = await callAppAgentTool(app, tool, body.args, rpc);
    return NextResponse.json(payload, { status });
  }

  // REVIEW H-2: the DOMAIN-ADOPTION layer is injected HERE, at the composition layer, because a
  // tab may not import another tab and the adoption store is the connections tab's
  // (`adoptActions` / `adoptionCovers` — the same four-layer primitive connection exposures use,
  // not a parallel one). The port is read fresh per call, so a revoked adoption bites
  // immediately; an unreachable store yields NO adoptions, which is fail-closed.
  let adoptions: Awaited<ReturnType<typeof allActiveAdoptions>> = [];
  try {
    adoptions = await allActiveAdoptions();
  } catch {
    adoptions = [];
  }
  const adoption = {
    adopted: (appExposureId: string, domain: string, actionName: string) =>
      adoptionCovers(adoptions, appExposureId, domain, actionName),
  };

  // The full governed spine (authorize → hold/deny → execute → trace) lives in
  // lib/software/app-tool-call.ts; the route only maps its result to HTTP.
  const { status, body: payload } = await callAppTool(app, tool, body.args, user.id, body, recordActor(user), adoption);
  return NextResponse.json(payload, { status });
}

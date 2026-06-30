/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getAppForUser } from '@/lib/apps';
import { getConnectionByApp } from '@/lib/app-registry';
import { authorizeAppTool, authorizeConnectionCall, trace } from '@/lib/agent-governed';
import { enqueue } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * Call an app's AUTO-GENERATED MCP tool as an agent would (Software golden path
 * §4 + Agent golden path). The call funnels through the SAME governed spine as
 * every other agent tool: OPA-style authorize (here resolved from the app's
 * dynamic grant in the app-registry) + Langfuse trace. A tool the app's MCP did
 * not expose is denied — honest default-deny.
 *
 * Offline the tools return deterministic seed data (the renewals slice) so the
 * end-to-end "agent calls the app" flow is demonstrable with no live Supabase.
 */
const SEED_RENEWALS = [
  { id: 'r1', account: 'ACME', product: 'Platform — Enterprise', amount: 48000, renews_on: '2026-09-30', status: 'upcoming' },
  { id: 'r2', account: 'Globex', product: 'Platform — Team', amount: 12000, renews_on: '2026-07-15', status: 'upcoming' },
];

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

  const conn = getConnectionByApp(app.id);
  const tool = String(body?.tool ?? '');
  const principal = app.mcpPrincipal;
  const toolDef = (conn?.tools ?? app.mcpTools).find((t) => t.name === tool);
  const known = Boolean(toolDef);

  // Honor the auto-MCP capability profile (reads-on / writes-off preset compiled
  // to OPA). A read tool is allowed; a write tool is HELD for human approval and
  // queued in the Governance inbox — never silently executed. Falls back to the
  // app-registry grant when no compiled profile is present (older in-memory app).
  const profile = authorizeConnectionCall(principal, tool, body.args);
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
      requestedBy: user.id,
      tool,
      payload: { appId: app.id, args: body.args ?? {} },
    });
    const tr = await trace({ principal, tool, input: body.args ?? {}, output: { held: true, reason: authz.reason }, decision: 'requires_approval' });
    return NextResponse.json(
      { tool, principal, decision: 'requires_approval', policy: authz.policy, reason: authz.reason, held: true, traceId: tr.id },
      { status: 202 },
    );
  }
  if (authz.effect !== 'allow') {
    const tr = await trace({ principal, tool, input: body, output: { denied: authz.reason }, decision: 'deny' });
    return NextResponse.json(
      { tool, principal, decision: authz.effect, policy: authz.policy, reason: authz.reason, traceId: tr.id },
      { status: 403 },
    );
  }

  // Execute the (seed-backed) tool.
  let result: unknown;
  if (tool === 'list_renewals') result = { renewals: SEED_RENEWALS };
  else if (tool === 'get_renewal') result = { renewal: SEED_RENEWALS.find((r) => r.id === String(body.args?.id)) ?? null };
  else if (tool === 'add_renewal') result = { added: { id: `r${Date.now().toString(36)}`, ...(body.args ?? {}) } };
  else if (tool === 'export_renewals') result = { file: `${app.slug}-export.csv`, rows: SEED_RENEWALS.length };
  else result = { ok: true, note: known ? 'executed' : 'generic tool' };

  const tr = await trace({ principal, tool, input: body.args ?? {}, output: result, decision: 'allow', costUsd: 0.0004 });
  return NextResponse.json({ tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, result });
}

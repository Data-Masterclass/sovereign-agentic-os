/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, templateFiles } from '@/lib/software/apps';
import { getSnapshot } from '@/lib/software/snapshot';
import { runnerStatus, runnerName } from '@/lib/software/runner';
import { resolveToolOperation, fillPathParams, seedToolResult } from '@/lib/software/tool-exec';
import { config } from '@/lib/core/config';
import { authorizeAppTool, authorizeConnectionCall, trace } from '@/lib/infra/agent-governed';
import { enqueue } from '@/lib/governance/approvals';

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
 * demonstrable — ALWAYS labelled `source:'demo-seed'` with a visible note.
 */

/** Proxy the tool call to the app's real in-cluster Service (`http://app-<slug>.<ns>`). */
async function callLiveApp(
  slug: string,
  op: { method: string; path: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const path = fillPathParams(op.path, args);
  const base = `http://${runnerName(slug)}.${config.softwareRunnerNamespace}`;
  const isGet = op.method === 'GET' || op.method === 'HEAD';
  const query = isGet && Object.keys(args).length > 0
    ? '?' + new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()
    : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}${path}${query}`, {
      method: op.method,
      headers: { accept: 'application/json', ...(isGet ? {} : { 'content-type': 'application/json' }) },
      body: isGet ? undefined : JSON.stringify(args),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw.slice(0, 2000);
    }
    return { source: 'live-app', endpoint: `${op.method} ${path}`, status: res.status, body };
  } catch {
    return null; // service unreachable despite a running pod → honest demo fallback
  } finally {
    clearTimeout(timer);
  }
}

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
  const principal = app.mcpPrincipal;

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

  // Execute: proxy to the REAL app when its runner pod is running, else demo seed.
  const args = (body.args ?? {}) as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  const status = await runnerStatus({ slug: app.slug });
  if (status.live && status.phase === 'running') {
    const files = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
    const op = resolveToolOperation(files, tool);
    if (op) result = await callLiveApp(app.slug, op, args);
  }
  if (!result) result = seedToolResult(tool, args);

  const tr = await trace({ principal, tool, input: body.args ?? {}, output: result, decision: 'allow', costUsd: 0.0004 });
  return NextResponse.json({ tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, result });
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import {
  authorize,
  metricsTool,
  retrieveTool,
  trace,
  SALES,
  type ToolName,
} from '@/lib/agent-governed';
import { enqueue } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * One governed agent-tool endpoint — the agent-side mirror of the data spine's
 * `/api/data/tool`. Every call is OPA-authorized (allow/deny/requires_approval)
 * and Langfuse-traced, so the governance pattern is identical no matter which
 * tool an agent reaches for.
 *
 *   POST { tool: 'metrics',  measure? }                 -> Cube semantic layer
 *   POST { tool: 'retrieve', query }                    -> governed RAG passages
 *   POST { tool: 'connection_crm_write', payload }      -> held for approval
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let body: { tool?: string; measure?: string; query?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tool = body?.tool as ToolName | undefined;
  const valid: ToolName[] = ['metrics', 'retrieve', 'connection_crm_read', 'connection_crm_write', 'write_file'];
  if (!tool || !valid.includes(tool)) {
    return NextResponse.json({ error: `tool must be one of ${valid.join(', ')}` }, { status: 400 });
  }

  const principal = SALES.principal;
  const authz = await authorize(principal, tool);

  if (authz.effect === 'deny') {
    const tr = await trace({ principal, tool, input: body, output: { denied: authz.reason }, decision: 'deny' });
    return NextResponse.json(
      { tool, principal, decision: 'deny', policy: authz.policy, reason: authz.reason, traceId: tr.id },
      { status: 403 },
    );
  }

  if (authz.effect === 'requires_approval') {
    const ap = enqueue({
      kind: 'connection_write',
      title: `Governed ${tool} by ${principal}`,
      detail: `Direct ${tool} call held for human approval (§7 requires_approval).`,
      agent: principal,
      domain: SALES.domain,
      requestedBy: user.id,
      tool,
      payload: body.payload ?? {},
    });
    const tr = await trace({ principal, tool, input: body, output: { held: ap.id }, decision: 'requires_approval' });
    return NextResponse.json(
      { tool, principal, decision: 'requires_approval', policy: authz.policy, approvalId: ap.id, traceId: tr.id },
      { status: 202 },
    );
  }

  // allow -> execute the read tool.
  try {
    if (tool === 'metrics') {
      const measure = body.measure ?? SALES.revenueMeasure;
      const r = await metricsTool(measure);
      const tr = await trace({ principal, tool, input: { measure }, output: r, decision: 'allow', costUsd: 0.0008 });
      return NextResponse.json({ tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, ...r });
    }
    if (tool === 'retrieve') {
      const query = (body.query ?? '').toString().trim() || `${SALES.account} renewal`;
      const passages = await retrieveTool(query);
      const tr = await trace({ principal, tool, input: { query }, output: passages, decision: 'allow', costUsd: 0.0006 });
      return NextResponse.json({ tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, passages });
    }
    // connection_crm_read / write_file — low-stakes reads/sandbox writes.
    const tr = await trace({ principal, tool, input: body, output: { ok: true }, decision: 'allow', costUsd: 0.0003 });
    return NextResponse.json({ tool, principal, decision: 'allow', policy: authz.policy, traceId: tr.id, ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

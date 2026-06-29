/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { callConnectionTool } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * Call a connection's governed tool as an agent would. The capability gate
 * (Off/Read/Write-approval/Write-bounded/Blocked + bounded limits + per-agent
 * restriction) decides allow / deny / requires_approval. A held write is enqueued
 * into the Governance approval queue. Every call is Langfuse-traced; the secret is
 * injected server-side and never appears in the response or trace.
 *
 * Body: { tool, args?, asAgent? }. A deny/held returns a non-200 with the reason.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;
  let body: { tool?: string; args?: Record<string, unknown>; asAgent?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body?.tool) return NextResponse.json({ error: 'A tool name is required' }, { status: 400 });

  try {
    const out = await callConnectionTool(id, user, {
      tool: String(body.tool),
      args: body.args ?? {},
      asAgent: body.asAgent ? String(body.asAgent) : undefined,
    });
    const status = out.decision === 'allow' ? 200 : out.decision === 'requires_approval' ? 202 : 403;
    return NextResponse.json(out, { status });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

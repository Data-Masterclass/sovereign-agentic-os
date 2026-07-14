/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { callConnectionTool } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * A thin REST surface over the governed Airflow tools of one `airflow` connection.
 * Every action routes through the SAME `callConnectionTool` gate as the MCP + the
 * generic tool door — so the capability profile decides allow / deny / held:
 *   • list / status  → Read, auto-allowed;
 *   • trigger        → Write-approval by default, HELD for Governance approval.
 * The vaulted credential is injected server-side and never appears in the response.
 *
 * GET  ?action=list                          → list_dags
 * GET  ?action=status&dagId=..&runId=..      → get_dag_run
 * POST { dagId, conf?, logicalDate? }        → trigger_dag (held for approval)
 */

async function auth(): Promise<{ user: Awaited<ReturnType<typeof requireUser>> } | { error: NextResponse }> {
  try {
    return { user: await requireUser() };
  } catch (e) {
    return { error: NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }) };
  }
}

/** allow→200, held/proposed→202, deny/block→403. */
function statusFor(decision: unknown): number {
  return decision === 'allow' ? 200 : decision === 'requires_approval' || decision === 'propose' ? 202 : 403;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'list';
  try {
    if (action === 'status') {
      const dagId = (url.searchParams.get('dagId') ?? '').trim();
      const runId = (url.searchParams.get('runId') ?? '').trim();
      if (!dagId || !runId) return NextResponse.json({ error: 'status needs a dagId and a runId' }, { status: 400 });
      const out = await callConnectionTool(id, a.user, { tool: 'get_dag_run', args: { dagId, runId } });
      return NextResponse.json(out, { status: statusFor(out.decision) });
    }
    // default: list
    const out = await callConnectionTool(id, a.user, { tool: 'list_dags', args: {} });
    return NextResponse.json(out, { status: statusFor(out.decision) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number })?.status ?? 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { id } = await ctx.params;
  let body: { dagId?: string; conf?: Record<string, unknown>; logicalDate?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const dagId = String(body?.dagId ?? '').trim();
  if (!dagId) return NextResponse.json({ error: 'trigger needs a dagId' }, { status: 400 });
  const args: Record<string, unknown> = { dagId };
  if (body.conf && typeof body.conf === 'object') args.conf = body.conf;
  if (body.logicalDate) args.logicalDate = String(body.logicalDate);
  try {
    const out = await callConnectionTool(id, a.user, { tool: 'trigger_dag', args });
    return NextResponse.json(out, { status: statusFor(out.decision) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number })?.status ?? 500 });
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { runSalesAssistant } from '@/lib/sales-assistant';
import { recentTraces } from '@/lib/agent-governed';
import { listFacts } from '@/lib/agent-memory';
import { SALES } from '@/lib/agent-governed';

export const dynamic = 'force-dynamic';

/**
 * Sales Assistant run endpoint (golden path §10/§11 vertical slice).
 *   POST { threadId, message } -> runs the supervisor graph, returns the answer,
 *     the governed steps (OPA decision + Langfuse trace per step), the KPI, any
 *     held approvals, recalled/stored memory and the run cost.
 *   GET  -> recent agent traces + the long-term memory the agent has accrued.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let body: { threadId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = (body?.message ?? '').toString().trim();
  if (!message) return NextResponse.json({ error: 'Ask the Sales Assistant something' }, { status: 400 });
  const threadId = (body?.threadId ?? `t_${user.id}`).toString();

  try {
    const result = await runSalesAssistant({ user: { id: user.id, role: user.role }, threadId, message });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  return NextResponse.json({
    traces: recentTraces(30),
    memory: listFacts(SALES.domain, SALES.principal),
  });
}

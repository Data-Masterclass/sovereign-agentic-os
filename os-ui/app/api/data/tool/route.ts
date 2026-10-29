/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { authorize, queryRun, trace } from '@core/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * The governed data `query` tool an agent (or the UI) calls — exposed through one
 * OPA-authorized, Langfuse-traced endpoint so every data access is policy-checked
 * and audited, exactly like the LiteLLM MCP gateway does for the LangGraph agent.
 *
 *   POST { tool: 'query', sql: '<read-only SQL>' } -> Trino over Iceberg marts
 *
 * The principal is the signed-in user's domain (the OPA grant unit); the response
 * always reports which policy decision applied + whether the call was traced.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  let body: { tool?: string; sql?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tool = body?.tool;
  if (tool !== 'query') {
    return NextResponse.json({ error: "tool must be 'query'" }, { status: 400 });
  }

  // OPA: principal = the caller's primary domain (the grant unit).
  const principal = user.domains[0] ?? user.id;
  const authz = await authorize(principal, tool);
  if (!authz.allowed) {
    return NextResponse.json(
      { error: `OPA denied ${principal} → ${tool}`, policy: authz.policy, authorized: false },
      { status: 403 },
    );
  }

  try {
    const sql = (body.sql ?? '').toString().trim();
    if (!sql) return NextResponse.json({ error: 'query tool needs sql' }, { status: 400 });
    const result = await queryRun(sql, principal);
    const traced = await trace({ principal, tool, input: sql, output: result.rows });
    return NextResponse.json({ tool, principal, authorized: true, policy: authz.policy, traced, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

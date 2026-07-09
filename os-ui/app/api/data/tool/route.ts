/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { authorize, cubeLoad, queryRun, trace, type CubeQuery } from '@/lib/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * The two governed data tools an agent (or the UI) calls — exposed through one
 * OPA-authorized, Langfuse-traced endpoint so every data access is policy-checked
 * and audited, exactly like the LiteLLM MCP gateway does for the LangGraph agent.
 *
 *   POST { tool: 'metrics', query: <CubeQuery> }   -> Cube semantic layer
 *   POST { tool: 'query',   sql: '<read-only SQL>' } -> Trino over Iceberg marts
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

  let body: { tool?: string; query?: CubeQuery; sql?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tool = body?.tool;
  if (tool !== 'metrics' && tool !== 'query') {
    return NextResponse.json({ error: "tool must be 'metrics' or 'query'" }, { status: 400 });
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
    if (tool === 'metrics') {
      const query = (body.query ?? {}) as CubeQuery;
      if (!query.measures?.length) {
        return NextResponse.json({ error: 'metrics tool needs at least one measure' }, { status: 400 });
      }
      const { rows, annotation } = await cubeLoad(query);
      const traced = await trace({ principal, tool, input: query, output: rows });
      return NextResponse.json({
        tool, principal, authorized: true, policy: authz.policy, traced,
        engine: 'cube', rows, annotation,
      });
    }
    // query tool
    const sql = (body.sql ?? '').toString().trim();
    if (!sql) return NextResponse.json({ error: 'query tool needs sql' }, { status: 400 });
    const result = await queryRun(sql, principal);
    const traced = await trace({ principal, tool, input: sql, output: result.rows });
    return NextResponse.json({ tool, principal, authorized: true, policy: authz.policy, traced, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { authorize, cubeLoad, queryRun, trace, type CubeQuery } from '@/lib/infra/governed';
import { privatePrefix } from '@/lib/data/personal-lane';
import { claimsFromUser } from '@/lib/data/identity';
import { runAgentTool, type AgentScope, type Executors, type ToolKind } from '@/lib/data/agent-tools';

export const dynamic = 'force-dynamic';

/**
 * The scoped data-agent tools endpoint. Runs the `personal` / `domain` / `marketplace`
 * tool under the signed-in user's DELEGATED identity (R2), forwarding the user to Trino
 * (RLS) and the per-user securityContext to Cube (R3). SINGLE-ENGINE: the personal lane
 * runs through the SAME governed Trino path (AS the owner), so there is no separate
 * query engine. Wires the real governed executors into the pure {@link runAgentTool}.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { scope?: AgentScope; kind?: ToolKind; sql?: string; query?: CubeQuery };
  const scope = body.scope;
  if (!scope || !['personal', 'domain', 'marketplace'].includes(scope)) {
    return NextResponse.json({ error: 'scope must be personal | domain | marketplace' }, { status: 400 });
  }

  const executors: Executors = {
    authorize: (principal, tool) => authorize(principal, tool),
    async trinoQuery(sql, principal) {
      const r = await queryRun(sql, principal);
      return { columns: r.columns, rows: r.rows };
    },
    async cubeQuery(query, securityContext) {
      const r = await cubeLoad(query as CubeQuery, { securityContext });
      return { rows: r.rows };
    },
    trace: (event) => trace({ principal: String(event.principal), tool: event.tool === 'metrics' ? 'metrics' : 'query', input: event, output: {} }),
  };

  try {
    const claims = claimsFromUser({ id: user.id, domains: user.domains, role: user.role });
    const result = await runAgentTool(claims, { scope, kind: body.kind === 'metrics' ? 'metrics' : 'query', sql: body.sql, query: body.query }, executors);
    return NextResponse.json({ ...result, prefix: scope === 'personal' ? privatePrefix(user.id) : undefined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}

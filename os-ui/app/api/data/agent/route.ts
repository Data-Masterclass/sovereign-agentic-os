/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { authorize, cubeLoad, queryRun, trace, type CubeQuery } from '@/lib/governed';
import { assertSandboxScoped, privatePrefix } from '@/lib/sandbox';
import { claimsFromUser } from '@/lib/data/identity';
import { runAgentTool, type AgentScope, type Executors, type ToolKind } from '@/lib/data/agent-tools';

export const dynamic = 'force-dynamic';

/**
 * The scoped data-agent tools endpoint. Runs the `personal` / `domain` / `marketplace`
 * tool under the signed-in user's DELEGATED identity (R2), forwarding the user to Trino
 * (RLS) and the per-user securityContext to Cube (R3). Wires the real governed/sandbox
 * executors into the pure {@link runAgentTool}.
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
    async sandboxQuery(sql, prefix) {
      const res = await fetch(`${config.sandboxDuckdbUrl}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, prefix }), cache: 'no-store', signal: AbortSignal.timeout(6000),
      }).catch(() => null);
      if (!res || !res.ok) return { columns: [], rows: [] }; // sandbox not reachable locally
      const d = (await res.json().catch(() => ({}))) as { columns?: string[]; rows?: string[][] };
      return { columns: d.columns ?? [], rows: d.rows ?? [] };
    },
    trace: (event) => trace({ principal: String(event.principal), tool: event.tool === 'metrics' ? 'metrics' : 'query', input: event, output: {} }),
    assertSandboxScoped,
  };

  try {
    const claims = claimsFromUser({ id: user.id, domains: user.domains, role: user.role });
    const result = await runAgentTool(claims, { scope, kind: body.kind === 'metrics' ? 'metrics' : 'query', sql: body.sql, query: body.query }, executors);
    return NextResponse.json({ ...result, prefix: scope === 'personal' ? privatePrefix(user.id) : undefined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}
